/** Navigation for the packaged Android shell only. Call site must use isAndroid(). */
export const ANDROID_READER_BACK_EVENT = "koodo:android-reader-back";
const APP_ORIGIN = "https://localhost";
const HOME = "#/manager/home";
const RETURN_KEY = "koodo.android.reader.return";
const MANAGER_HASH = /^#\/manager\/(empty|note|highlight|home|shelf|favorite|trash)(?:\?[^#]*)?$/;
const FORMAT = /^(epub|mobi|cbr|cbt|cbz|cb7|azw3|azw|txt|docx|md|fb2|html|htm|xml|xhtml|mhtml|href|pdf)$/;
export type ReaderLibraryState = { hash: string; shelfTitle: string };

const currentShell = () => {
  const url = new URL(window.location.href);
  return url.origin === APP_ORIGIN && !url.username && !url.password &&
    !url.search && (url.pathname === "/" || url.pathname === "/index.html")
    ? url : null;
};

const flipDocument = (url: URL, hash: string) => {
  // Changing the document avoids retaining the baseline reader's window key
  // handlers, async rendition callbacks, and Redux state in the library.
  url.pathname = url.pathname === "/" ? "/index.html" : "/";
  url.hash = hash;
  window.location.replace(url.href);
};

export const openAndroidReader = (
  format: string,
  key: string,
  title: string,
  shelfTitle: string,
): boolean => {
  const url = currentShell();
  if (!url || !FORMAT.test(format) || !key || /[/#?]/.test(key)) return false;
  const returnHash = MANAGER_HASH.test(url.hash) ? url.hash : HOME;
  const query = new URLSearchParams({ title, file: key, returnTo: returnHash });
  if (returnHash.split("?")[0] === "#/manager/shelf") {
    query.set("returnShelf", shelfTitle);
  }
  flipDocument(url, `#/${format}/${key}?${query.toString()}`);
  return true;
};

export const isAndroidReaderLocation = (): boolean => {
  const url = currentShell();
  const match = url && /^#\/([^/]+)\/([^/?#]+)(?:\?[^#]*)?$/.exec(url.hash);
  return !!match && FORMAT.test(match[1]);
};

export const returnFromAndroidReader = (): boolean => {
  const url = currentShell();
  if (!url || !isAndroidReaderLocation()) return false;
  const question = url.hash.indexOf("?");
  const query = new URLSearchParams(question < 0 ? "" : url.hash.slice(question + 1));
  const requested = query.get("returnTo") || "";
  const hash = MANAGER_HASH.test(requested) ? requested : HOME;
  const shelfTitle = hash.split("?")[0] === "#/manager/shelf"
    ? query.get("returnShelf") || "" : "";
  try {
    window.sessionStorage.setItem(RETURN_KEY, JSON.stringify({ hash, shelfTitle }));
  } catch {
    // Only the manager's startup-shelf override guard requires sessionStorage.
    // The validated library route itself is carried in the reader URL.
  }
  flipDocument(url, hash);
  return true;
};

/** Read once in Manager.componentDidMount(), before its startup-shelf redirect. */
export const takeReaderLibraryReturn = (): ReaderLibraryState | null => {
  const url = currentShell();
  if (!url || !MANAGER_HASH.test(url.hash)) return null;
  try {
    const content = window.sessionStorage.getItem(RETURN_KEY);
    window.sessionStorage.removeItem(RETURN_KEY);
    if (!content) return null;
    const record = JSON.parse(content);
    if (record && record.hash === url.hash && typeof record.shelfTitle === "string") {
      return { hash: record.hash, shelfTitle: record.shelfTitle };
    }
  } catch {
    return null;
  }
  return null;
};

/** Install from the mounted Reader, not from an iframe. Returns the same
 * action for the visible Back button and an unmount cleanup. */
export const bindAndroidReaderBack = (
  closeTopLayer: () => boolean,
  beforeExit: () => void,
) => {
  let leaving = false;
  const back = () => {
    if (!isAndroidReaderLocation()) return false;
    if (leaving || closeTopLayer()) return true;
    leaving = true;
    try {
      beforeExit();
    } finally {
      if (!returnFromAndroidReader()) leaving = false;
    }
    return true;
  };
  const listener = (event: Event) => {
    if (isAndroidReaderLocation()) {
      event.preventDefault();
      back();
    }
  };
  window.addEventListener(ANDROID_READER_BACK_EVENT, listener);
  const shell = window as Window & { __koodoReaderBackPending?: boolean };
  const pending = Boolean(shell.__koodoReaderBackPending);
  delete shell.__koodoReaderBackPending;
  // Defer until the mounting Reader has registered its other listeners.
  const pendingTimer = pending ? window.setTimeout(back, 0) : undefined;
  return {
    back,
    dispose: () => {
      window.removeEventListener(ANDROID_READER_BACK_EVENT, listener);
      if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    },
  };
};
