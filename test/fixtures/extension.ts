import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * A made-up browser for the companion extension: the scripts in `extension/` are loaded
 * exactly as Chrome would load them, into separate contexts, against stand-ins for Chrome's
 * extension interfaces and for a page that opens a socket. Nothing here is Slack, and the
 * "page" is not a copy of Slack's client: it is the least that lets the scripts run.
 */
export const EXTENSION_DIR = new URL('../../extension/', import.meta.url);
export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const source = (file: string): string => readFileSync(new URL(file, EXTENSION_DIR), 'utf8');

type Listener = (message: any, sender: any, respond: (value: unknown) => void) => unknown;

class Area {
  data = new Map<string, unknown>();
  accessLevel: string | null = null;
  get = (keys: string[] | string): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {};
    for (const key of Array.isArray(keys) ? keys : [keys]) if (this.data.has(key)) out[key] = structuredClone(this.data.get(key));
    return Promise.resolve(out);
  };
  set = (values: Record<string, unknown>): Promise<void> => {
    for (const [key, value] of Object.entries(values)) this.data.set(key, structuredClone(value));
    return Promise.resolve();
  };
  remove = (keys: string[]): Promise<void> => {
    for (const key of keys) this.data.delete(key);
    return Promise.resolve();
  };
  setAccessLevel = (input: { accessLevel: string }): Promise<void> => {
    this.accessLevel = input.accessLevel;
    return Promise.resolve();
  };
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentials?: string;
}

/** A socket as a page sees one. It records whether anything read its address or sent on it. */
export class FakeSocket extends EventTarget {
  static opened: FakeSocket[] = [];
  static addressReads = 0;
  static sends = 0;
  readonly #url: string;
  constructor(url: string) {
    super();
    this.#url = url;
    FakeSocket.opened.push(this);
  }
  get url(): string {
    FakeSocket.addressReads += 1;
    return this.#url;
  }
  send(): void {
    FakeSocket.sends += 1;
  }
  open(): void {
    this.dispatchEvent(new Event('open'));
  }
  close(): void {
    this.dispatchEvent(new Event('close'));
  }
  /** The server pushes one frame. */
  push(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: typeof frame === 'string' || frame instanceof ArrayBuffer ? frame : JSON.stringify(frame) }));
  }
  static reset(): void {
    FakeSocket.opened = [];
    FakeSocket.addressReads = 0;
    FakeSocket.sends = 0;
  }
}

export interface PageElement {
  attributes?: Record<string, string>;
  textContent?: string;
  src?: string;
  href?: string;
  children?: Record<string, PageElement>;
}

/** One tab on the made-up app.slack.com: the page's world with tap.js in it, and the extension's world with content.js. */
export class FakeTab {
  readonly document = Object.assign(new EventTarget(), {
    title: '',
    hidden: true,
    cookie: 'd=made-up-session-cookie',
    querySelectorAll: (selector: string): unknown[] => this.query(selector),
    querySelector: (selector: string): unknown => this.query(selector)[0] ?? null,
  });
  location = { pathname: '/client/T0ACME/C0ACMEPORTAL' };
  /** What the page shows, by selector. */
  elements = new Map<string, PageElement[]>();
  notificationPermission = 'denied';
  discarded = false;
  pinned = true;
  /** False: the content script is not there, as in a tab opened before the extension was loaded. */
  injected = true;
  listeners: Listener[] = [];
  window: Record<string, unknown>;
  workersStarted = 0;
  onStorageTouched = 0;

  constructor(
    readonly browser: FakeBrowser,
    readonly id: number,
    path?: string,
  ) {
    if (path) this.location.pathname = path;
    const tab = this;
    const touched = () => {
      tab.onStorageTouched += 1;
      return undefined;
    };
    this.window = {
      WebSocket: FakeSocket,
      Worker: class {
        constructor() {
          tab.workersStarted += 1;
        }
      },
      CustomEvent,
      // A page's stores hold the session. Reading any of them is counted, and the tests require the count to stay at zero.
      get localStorage() {
        return touched();
      },
      get sessionStorage() {
        return touched();
      },
      get indexedDB() {
        return touched();
      },
    };
  }

  private query(selector: string): unknown[] {
    return (this.elements.get(selector) ?? []).map((e) => this.element(e));
  }

  private element(e: PageElement): unknown {
    return {
      textContent: e.textContent ?? '',
      src: e.src ?? '',
      href: e.href ?? '',
      getAttribute: (name: string) => e.attributes?.[name] ?? null,
      querySelector: (selector: string) => (e.children?.[selector] ? this.element(e.children[selector]) : null),
    };
  }

  get url(): string {
    return `https://app.slack.com${this.location.pathname}`;
  }

  /** Loads the page: tap.js first, in the page's world, then the extension's scripts in theirs. */
  load(): this {
    const page = vm.createContext({ window: this.window, document: this.document, EventTarget, console });
    vm.runInContext(source('tap.js'), page, { filename: 'tap.js' });
    if (!this.injected) return this;
    const tab = this;
    const isolated = vm.createContext({
      document: this.document,
      location: this.location,
      CustomEvent,
      console,
      get Notification() {
        return Object.assign(function Notification() {}, { permission: tab.notificationPermission });
      },
      chrome: {
        runtime: {
          sendMessage: (message: unknown) => this.browser.fromTab(this, message),
          onMessage: { addListener: (listener: Listener) => this.listeners.push(listener) },
        },
      },
    });
    vm.runInContext(source('lib.js'), isolated, { filename: 'lib.js' });
    vm.runInContext(source('content.js'), isolated, { filename: 'content.js' });
    return this;
  }

  /** The page opens a socket, the way Slack's client would: with its credential in the address. */
  socket(address = 'wss://wss-primary.slack.test/?token=xoxc-made-up-socket-token&gateway_server=T0ACME-1'): FakeSocket {
    const Socket = this.window.WebSocket as new (url: string) => FakeSocket;
    const socket = new Socket(address);
    socket.open();
    return socket;
  }

  deliver(message: unknown): Promise<unknown> {
    if (!this.listeners.length) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    return new Promise((resolve) => {
      for (const listener of this.listeners) listener(structuredClone(message), { id: EXTENSION_ID }, (value) => resolve(structuredClone(value)));
    });
  }
}

/** Chrome, as far as the extension's background worker uses it. */
export class FakeBrowser {
  local = new Area();
  session = new Area();
  tabs: FakeTab[] = [];
  /** Tabs that still exist but show a page outside app.slack.com. */
  elsewhere = new Set<number>();
  fetches: FetchCall[] = [];
  badge = '';
  alarms = new Map<string, unknown>();
  private messageListeners: Listener[] = [];
  private alarmListeners: ((alarm: { name: string }) => void)[] = [];
  private context: vm.Context | null = null;
  private nextTab = 1;

  constructor(private readonly respond: (call: FetchCall) => Promise<{ status: number; json: unknown }>) {}

  tab(path?: string): FakeTab {
    const tab = new FakeTab(this, this.nextTab++, path);
    this.tabs.push(tab);
    return tab;
  }

  close(tab: FakeTab): void {
    this.tabs = this.tabs.filter((t) => t !== tab);
  }

  /** The tab navigates away from app.slack.com, as it does for a sign-in page on the workspace's own address. */
  leave(tab: FakeTab): void {
    this.close(tab);
    this.elsewhere.add(tab.id);
  }

  /** Starts the background worker, as Chrome does for an alarm or a message. */
  startWorker(): this {
    const chrome = {
      runtime: {
        id: EXTENSION_ID,
        getManifest: () => JSON.parse(source('manifest.json')) as unknown,
        getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
        openOptionsPage: () => undefined,
        onMessage: { addListener: (listener: Listener) => this.messageListeners.push(listener) },
        onInstalled: { addListener: () => undefined },
        onStartup: { addListener: () => undefined },
      },
      storage: { local: this.local, session: this.session },
      alarms: {
        get: (name: string) => Promise.resolve(this.alarms.get(name)),
        create: (name: string, options: unknown) => void this.alarms.set(name, options),
        onAlarm: { addListener: (listener: (alarm: { name: string }) => void) => this.alarmListeners.push(listener) },
      },
      action: {
        setBadgeText: (input: { text: string }) => {
          this.badge = input.text;
          return Promise.resolve();
        },
        onClicked: { addListener: () => undefined },
      },
      tabs: {
        query: (input: { url: string }) => {
          if (input.url !== 'https://app.slack.com/*') return Promise.reject(new Error('no permission for that address'));
          return Promise.resolve(this.tabs.map((t) => ({ id: t.id, url: t.url, discarded: t.discarded, pinned: t.pinned, autoDiscardable: true })));
        },
        sendMessage: (tabId: number, message: unknown) => {
          const tab = this.tabs.find((t) => t.id === tabId);
          return tab && !tab.discarded ? tab.deliver(message) : Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        },
        get: (tabId: number) => (this.tabs.some((t) => t.id === tabId) || this.elsewhere.has(tabId) ? Promise.resolve({ id: tabId }) : Promise.reject(new Error(`No tab with id: ${tabId}`))),
      },
    };
    const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string; credentials?: string }) => {
      const call: FetchCall = { url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body), credentials: init.credentials };
      this.fetches.push(call);
      const answer = await this.respond(call);
      return { status: answer.status, json: () => Promise.resolve(answer.json) };
    };
    const context = vm.createContext({ chrome, fetch, URL, AbortSignal, setTimeout, console });
    (context as { importScripts: (file: string) => void }).importScripts = (file: string) => vm.runInContext(source(file), context, { filename: file });
    vm.runInContext(source('background.js'), context, { filename: 'background.js' });
    this.context = context;
    return this;
  }

  /** Chrome stops the idle worker and starts it again later: nothing in memory survives. */
  restartWorker(): this {
    this.messageListeners = [];
    this.alarmListeners = [];
    return this.startWorker();
  }

  private dispatch(message: unknown, sender: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      let async = false;
      for (const listener of this.messageListeners) {
        if (listener(structuredClone(message), sender, (value) => resolve(value === undefined ? undefined : structuredClone(value))) === true) async = true;
      }
      if (!async) resolve(undefined);
    });
  }

  fromTab(tab: FakeTab, message: unknown): Promise<unknown> {
    return this.dispatch(message, { id: EXTENSION_ID, url: tab.url, tab: { id: tab.id } });
  }

  /** A message from the extension's own page. */
  fromOptions(message: unknown): Promise<any> {
    return this.dispatch(message, { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/options.html`, tab: { id: 999 } });
  }

  /** The minute alarm fires. Resolves when the worker has finished what it started. */
  async alarm(): Promise<void> {
    for (const listener of this.alarmListeners) listener({ name: 'tick' });
    await this.idle();
  }

  /** Waits until the worker has nothing left in its queue of work. */
  async idle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await this.fromOptions({ kind: 'status' });
  }

  get worker(): vm.Context {
    if (!this.context) throw new Error('the worker has not been started');
    return this.context;
  }
}

/** lib.js on its own, for the parts that touch neither a page nor Chrome. */
export function loadLib(): any {
  const context = vm.createContext({ URL, console });
  vm.runInContext(source('lib.js'), context, { filename: 'lib.js' });
  return (context as { PatcherCompanion: unknown }).PatcherCompanion;
}
