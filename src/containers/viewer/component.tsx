import React from "react";
import { ViewerProps, ViewerState } from "./interface";
import { withRouter } from "react-router-dom";
import BookUtil from "../../utils/file/bookUtil";
import PopupMenu from "../../components/popups/popupMenu";
import Background from "../../components/background";
import StyleUtil from "../../utils/reader/styleUtil";
import "./index.css";
import { htmlMouseEvent } from "../../utils/reader/mouseEvent";
import ImageViewer from "../../components/imageViewer";
import { getIframeDoc } from "../../utils/reader/docUtil";
import PopupBox from "../../components/popups/popupBox";
import Note from "../../models/Note";
import PageWidget from "../pageWidget";
import {
  BRUSH_COLORS,
  BRUSH_WIDTHS,
  HIGHLIGHTER_COLORS,
  HIGHLIGHTER_WIDTHS,
  SHAPE_TYPES,
  TEXT_COLORS,
  getDefaultOcrEngine,
  getDefaultOcrLang,
  getPageWidth,
  getParserRegex,
  getPdfPassword,
  getTextRules,
  throttle,
} from "../../utils/common";
import _ from "underscore";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";
import * as Kookit from "../../assets/lib/kookit.min";
import PopupRefer from "../../components/popups/popupRefer";
import DatabaseService from "../../utils/storage/databaseService";
import { BookHelper } from "../../assets/lib/kookit.min";
import { isAndroid, isMobileDevice } from "../../platform";
import {
  parseWithExternalOcrApi,
  parseWithSystemOCR,
} from "../../utils/request/common";
declare var window: any;
let lock = false; //prevent from clicking too fasts

type MobileViewerProps = ViewerProps & { onMobileBodyTap?: () => void };
class Viewer extends React.Component<MobileViewerProps, ViewerState> {
  private mobilePageTurning = false;
  private readonly readerTapDocs = new WeakSet<Document>();
  private readonly readerTapAbort = new AbortController();
  private resizeHandler: (() => void) | null = null;
  private _pendingRerender = false;
  lock: boolean;
  constructor(props: ViewerProps) {
    super(props);
    this.state = {
      cfiRange: null,
      contents: null,
      rect: null,
      key: "",
      isFirst: true,
      chapterTitle:
        ConfigService.getObjectConfig(
          this.props.currentBook.key,
          "recordLocation",
          {}
        ).chapterTitle || "",
      isDisablePopup: ConfigService.getReaderConfig("isDisablePopup") === "yes",
      isTouch: ConfigService.getReaderConfig("isTouch") === "yes",
      chapterDocIndex: parseInt(
        ConfigService.getObjectConfig(
          this.props.currentBook.key,
          "recordLocation",
          {}
        ).chapterDocIndex || 0
      ),
      pageOffset: "",
      pageWidth: "",
      chapter: "",
      rendition: null,
    };
    this.lock = false;
  }
  UNSAFE_componentWillMount() {
    this.props.handleFetchBookmarks();
    this.props.handleFetchNotes();
    this.props.handleFetchBooks();
    this.props.handleFetchPlugins();
  }
  readerPageWidth = (
    mode: string,
    scale: string,
    margin: number,
    navLocked: boolean,
    settingLocked: boolean
  ) => {
    const format = this.props.currentBook.format.toUpperCase();
    if (isAndroid() && ["EPUB", "TXT", "MD", "FB2", "MOBI", "AZW", "AZW3", "DOCX"].includes(format)) {
      const viewport = document.body.clientWidth;
      if (viewport >= 72) {
        // Keep the engine's 48px alignment; mobile panels overlay the page.
        const gutter = Math.min(32, Math.max(8, Number.isFinite(margin) ? margin : 8));
        const width = Math.floor((viewport - 2 * gutter) / 48) * 48;
        if (width > 0) return { pageOffset: `${(viewport - width) / 2}px`, pageWidth: `${width}px` };
      }
    }
    return getPageWidth(mode, scale, margin, navLocked, settingLocked);
  };
  componentDidMount() {
    this.handleRenderBook();
    //make sure page width is always 12 times, section = Math.floor(element.clientWidth / 12), or text will be blocked
    this.setState(
      this.readerPageWidth(
        this.props.readerMode,
        this.props.scale,
        parseInt(this.props.margin),
        this.props.isNavLocked,
        this.props.isSettingLocked || this.props.isDockedRight
      )
    );
    // 刷新页面后，若 popupBox 处于固定右侧状态，自动恢复显示 popupAssist
    if (this.props.isDockedRight) {
      this.props.handleMenuMode("assistant");
      this.props.handleOpenMenu(true);
    }
    this.props.handleRenderBookFunc(this.handleRenderBook);
    this.resizeHandler = throttle(() => {
      this.setState(
        this.readerPageWidth(
          this.props.readerMode,
          this.props.scale,
          parseInt(this.props.margin),
          this.props.isNavLocked,
          this.props.isSettingLocked || this.props.isDockedRight
        )
      );
      if (lock) {
        this._pendingRerender = true;
      } else {
        this.handleRenderBook();
      }
    });
    window.addEventListener("resize", this.resizeHandler);
  }
  componentWillUnmount() {
    this.readerTapAbort.abort();
    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
  }
  async UNSAFE_componentWillReceiveProps(nextProps: ViewerProps) {
    if (
      nextProps.margin !== this.props.margin ||
      nextProps.scale !== this.props.scale ||
      nextProps.readerMode !== this.props.readerMode ||
      nextProps.isNavLocked !== this.props.isNavLocked ||
      nextProps.isSettingLocked !== this.props.isSettingLocked ||
      nextProps.isDockedRight !== this.props.isDockedRight
    ) {
      this.setState(
        this.readerPageWidth(
          nextProps.readerMode,
          nextProps.scale,
          parseInt(nextProps.margin),
          nextProps.isNavLocked,
          nextProps.isSettingLocked || nextProps.isDockedRight
        )
      );
    }
  }
  handleHighlight = async (rendition: any) => {
    if (!rendition) return;
    let highlighters: any = await DatabaseService.getRecordsByBookKey(
      this.props.currentBook.key,
      "notes"
    );
    if (!highlighters) return;
    let highlightersByChapter = highlighters.filter((item: Note) => {
      let cfi = JSON.parse(item.cfi);
      if (cfi.cfi) {
        // epub from 1.5.2 or older
        return (
          item.chapter ===
          rendition.getChapterDoc()[this.state.chapterDocIndex].label
        );
      } else if (cfi.fingerprint) {
        // pdf from 1.7.4 or older
        return cfi.page - 1 === this.state.chapterDocIndex;
      } else {
        return item.chapterIndex === this.state.chapterDocIndex;
      }
    });
    if (this.props.currentBook.format === "PDF") {
      highlightersByChapter = highlightersByChapter.map((item: Note) => {
        let cfi = JSON.parse(item.cfi);
        if (cfi.fingerprint) {
          item.chapterIndex = cfi.page - 1;
          cfi.chapterDocIndex = cfi.page - 1 + "";
          cfi.chapterHref = "title" + (cfi.page - 1);
          item.cfi = JSON.stringify(cfi);
        }

        return item;
      });
    }
    await rendition.renderHighlighters(
      highlightersByChapter,
      this.handleNoteClick
    );
    if (
      this.props.currentBook.format === "PDF" &&
      (this.props.readerMode === "double" ||
        this.props.readerMode === "scroll") &&
      !ConfigService.getAllListConfig("convertPDFBooks").includes(
        this.props.currentBook.key
      )
    ) {
      let highlightersByChapter = highlighters.filter((item: Note) => {
        let cfi = JSON.parse(item.cfi);
        if (cfi.fingerprint) {
          // pdf from 1.7.4 or older
          return cfi.page === this.state.chapterDocIndex;
        } else {
          return item.chapterIndex === this.state.chapterDocIndex + 1;
        }
      });
      if (this.props.currentBook.format === "PDF") {
        highlightersByChapter = highlightersByChapter.map((item: Note) => {
          let cfi = JSON.parse(item.cfi);
          if (cfi.fingerprint) {
            item.chapterIndex = cfi.page - 1;
            cfi.chapterDocIndex = cfi.page - 1 + "";
            cfi.chapterHref = "title" + (cfi.page - 1);
            item.cfi = JSON.stringify(cfi);
          }

          return item;
        });
      }
      await rendition.renderHighlighters(
        highlightersByChapter,
        this.handleNoteClick
      );
    }
  };
  handleNoteClick = (event: Event) => {
    this.props.handleNoteKey((event.target as any).dataset.key);
    this.props.handleMenuMode("note");
    this.props.handleOpenMenu(true);
  };
  handleRenderBook = async () => {
    if (lock) return;
    let { key, path, format, name } = this.props.currentBook;
    if (ConfigService.getAllListConfig("seperateStyleBooks").includes(key)) {
      window.currentBookKey = key;
      this.props.handleBackgroundColor(
        ConfigService.getReaderConfig("backgroundColor") || ""
      );
    } else {
      window.currentBookKey = "";
    }
    this.props.handleHtmlBook(null);
    if (this.state.rendition) {
      this.state.rendition.removeContent();
    }
    let isCacheExsit = await BookUtil.isBookExist("cache-" + key, "zip", path);
    BookUtil.fetchBook(
      isCacheExsit ? "cache-" + key : key,
      isCacheExsit ? "zip" : format.toLowerCase(),
      true,
      path
    ).then(async (result: any) => {
      const crop = ConfigService.getObjectConfig(
        this.props.currentBook.key,
        "pdfCrop",
        null
      );
      let pdfCrop;
      if (crop) {
        const top = Number(crop.top) || 0;
        const bottom = Number(crop.bottom) || 0;
        const left = Number(crop.left) || 0;
        const right = Number(crop.right) || 0;
        if (top !== 0 || bottom !== 0 || left !== 0 || right !== 0) {
          pdfCrop = { top, bottom, left, right };
        }
      }
      let rendition = BookHelper.getRendition(
        result,
        {
          format: isCacheExsit ? "CACHE" : format,
          readerMode: this.props.readerMode,
          charset: this.props.currentBook.charset,
          animation: ConfigService.getReaderConfig("animation") || "none",
          convertChinese: ConfigService.getReaderConfig("convertChinese"),
          bookLayout: ConfigService.getReaderConfig("bookLayout") || "",
          textRules: getTextRules(this.props.currentBook.key),
          codeHighlight: ConfigService.getReaderConfig("codeHighlight") || "",
          parserRegex: getParserRegex(
            this.props.currentBook.format,
            this.props.currentBook.key
          ),
          fullTranslationMode:
            ConfigService.getAllListConfig("fullTranslationBooks").includes(
              this.props.currentBook.key
            ) && this.props.isAuthed
              ? ConfigService.getReaderConfig("fullTranslationMode")
              : "no",
          textOrientation: ConfigService.getReaderConfig("textOrientation"),
          isDarkMode:
            ConfigService.getReaderConfig("backgroundColor") ===
            "rgba(44,47,49,1)"
              ? "yes"
              : "no",
          backgroundColor: ConfigService.getReaderConfig("backgroundColor"),
          isMobile: isMobileDevice() ? "yes" : "no",
          isIndent: ConfigService.getReaderConfig("isIndent"),
          isHyphenation: ConfigService.getReaderConfig("isHyphenation"),
          isStartFromEven: ConfigService.getReaderConfig("isStartFromEven"),
          isAllowScript: ConfigService.getReaderConfig("isAllowScript"),
          isBionic: ConfigService.getReaderConfig("isBionic"),
          password: getPdfPassword(this.props.currentBook),
          pdfCrop,
          scale: parseFloat(this.props.scale),
          isConvertPDF: ConfigService.getAllListConfig(
            "convertPDFBooks"
          ).includes(this.props.currentBook.key)
            ? "yes"
            : "no",
          ocrLang: getDefaultOcrLang(
            getDefaultOcrEngine(this.props.currentBook),
            this.props.currentBook
          ),
          externalWorker:
            getDefaultOcrEngine(this.props.currentBook) === "system-ocr" ||
            getDefaultOcrEngine(this.props.currentBook) === "external-ocr-api"
              ? {
                  recognize:
                    getDefaultOcrEngine(this.props.currentBook) === "system-ocr"
                      ? parseWithSystemOCR
                      : parseWithExternalOcrApi,
                }
              : undefined,
          ocrEngine: getDefaultOcrEngine(this.props.currentBook),
          serverRegion: "global",
          paraSpacingValue:
            ConfigService.getReaderConfig("paraSpacingValue") || "1.5",
          titleSizeValue:
            ConfigService.getReaderConfig("titleSizeValue") || "1.2",
          isScannedPDF:
            this.props.currentBook.description.indexOf("scanned") > -1
              ? "yes"
              : "no",
          brushColor:
            ConfigService.getReaderConfig("annotationBrushColor") ||
            BRUSH_COLORS[0],
          brushWidth: parseFloat(
            ConfigService.getReaderConfig("annotationBrushWidth") ||
              BRUSH_WIDTHS[1] + ""
          ),
          annotationStyle:
            ConfigService.getReaderConfig("annotationStyle") || "brush",
          highlighterColor:
            ConfigService.getReaderConfig("annotationHighlighterColor") ||
            HIGHLIGHTER_COLORS[0],
          highlighterWidth: parseFloat(
            ConfigService.getReaderConfig("annotationHighlighterWidth") ||
              HIGHLIGHTER_WIDTHS[1] + ""
          ),
          highlighterOpacity: parseFloat(
            ConfigService.getReaderConfig("annotationHighlighterOpacity") ||
              "0.4"
          ),
          shapeType:
            ConfigService.getReaderConfig("annotationShapeType") ||
            SHAPE_TYPES[0],
          shapeColor:
            ConfigService.getReaderConfig("annotationShapeColor") ||
            BRUSH_COLORS[0],
          shapeWidth: parseFloat(
            ConfigService.getReaderConfig("annotationShapeWidth") ||
              BRUSH_WIDTHS[1] + ""
          ),
          textSize: parseFloat(
            ConfigService.getReaderConfig("annotationTextSize") || "24"
          ),
          textFont:
            ConfigService.getReaderConfig("annotationTextFont") ||
            "sans-serif",
          textColor:
            ConfigService.getReaderConfig("annotationTextColor") ||
            TEXT_COLORS[0],
          isKeepPDFBackground: ConfigService.getReaderConfig(
            "isKeepPDFBackground"
          ),
        },
        Kookit
      );
      if (this.props.currentBook.format === "TXT") {
        let bookLocation = ConfigService.getObjectConfig(
          this.props.currentBook.key,
          "recordLocation",
          {}
        );
        await rendition.renderTo(
          document.getElementById("page-area"),
          bookLocation
        );
      } else {
        await rendition.renderTo(document.getElementById("page-area"));
      }

      await this.handleRest(rendition);
      this.props.handleReadingState(true);

      ConfigService.setListConfig(this.props.currentBook.key, "recentBooks");
      document.title = name + " - Koodo Reader";
    });
  };

  handleRest = async (rendition: any) => {
    htmlMouseEvent(
      rendition,
      this.props.currentBook.key,
      this.props.readerMode,
      this.props.currentBook.format,
      this.props.handleScale,
      this.props.renderBookFunc
    );
    let chapters = rendition.getChapter();
    let chapterDocs = rendition.getChapterDoc();
    let flattenChapters = rendition.flatChapter(chapters);
    this.props.handleHtmlBook({
      key: this.props.currentBook.key,
      chapters,
      flattenChapters,
      rendition: rendition,
    });
    this.setState({ rendition });
    if (
      this.props.currentBook.format === "PDF" &&
      !ConfigService.getAllListConfig("convertPDFBooks").includes(
        this.props.currentBook.key
      )
    ) {
      //ignore
    } else {
      StyleUtil.addDefaultCss(this.props.currentBook.key);
      await StyleUtil.applyReaderFonts(rendition);
    }

    let bookLocation: {
      text: string;
      count: string;
      chapterTitle: string;
      chapterDocIndex: string;
      chapterHref: string;
      percentage: string;
      cfi: string;
      page: string;
      xpath: string;
    } = ConfigService.getObjectConfig(
      this.props.currentBook.key,
      "recordLocation",
      {}
    );
    if (chapterDocs.length > 0) {
      if (
        ConfigService.getReaderConfig("isEnableKoReaderSync") === "yes" &&
        bookLocation.xpath
      ) {
        await rendition.goToXpath(bookLocation.xpath);
      } else {
        await rendition.goToPosition(
          JSON.stringify({
            text: bookLocation.text || "",
            chapterTitle: bookLocation.chapterTitle || "",
            page: bookLocation.page || "",
            chapterDocIndex: bookLocation.chapterDocIndex || 0,
            chapterHref: bookLocation.chapterHref || "",
            count: bookLocation.hasOwnProperty("cfi")
              ? "ignore"
              : bookLocation.count || 0,
            percentage: bookLocation.percentage,
            cfi: bookLocation.cfi,
            isFirst: true,
          })
        );
      }
    }
    rendition.on("rendered", async () => {
      this.handleLocation();
      let bookLocation: {
        text: string;
        count: string;
        chapterTitle: string;
        chapterDocIndex: string;
        chapterHref: string;
      } = ConfigService.getObjectConfig(
        this.props.currentBook.key,
        "recordLocation",
        {}
      );

      let chapter =
        bookLocation.chapterTitle ||
        (this.props.htmlBook && this.props.htmlBook.flattenChapters[0]
          ? ""
          : "Unknown chapter");
      let chapterDocIndex = 0;
      if (bookLocation.chapterDocIndex) {
        chapterDocIndex = parseInt(bookLocation.chapterDocIndex);
      } else {
        chapterDocIndex =
          bookLocation.chapterTitle && this.props.htmlBook
            ? _.findLastIndex(
                this.props.htmlBook.flattenChapters.map((item) => {
                  item.label = item.label.trim();
                  return item;
                }),
                {
                  label: bookLocation.chapterTitle.trim(),
                }
              )
            : 0;
      }
      this.props.handleCurrentChapter(chapter);
      this.props.handleCurrentChapterIndex(chapterDocIndex);

      this.setState({
        chapter,
        chapterDocIndex,
      });
      if (
        this.props.currentBook.format === "PDF" &&
        !ConfigService.getAllListConfig("convertPDFBooks").includes(
          this.props.currentBook.key
        )
      ) {
        //ignore
      } else {
        StyleUtil.addDefaultCss(this.props.currentBook.key);
        await StyleUtil.applyReaderFonts(rendition);
      }
      // rendition.tranformText();
      this.handleBindGesture();
      await this.handleHighlight(rendition);
      lock = true;
      setTimeout(() => {
        lock = false;
        if (this._pendingRerender) {
          this._pendingRerender = false;
          this.handleRenderBook();
        }
      }, 1000);
      return false;
    });
    if (
      this.props.currentBook.format === "TXT" &&
      rendition.format !== "CACHE"
    ) {
      if (
        flattenChapters.length > 0 &&
        flattenChapters[0].label === "Chapter 0"
      ) {
        return;
      }
      setTimeout(async () => {
        await rendition.refreshContent();
        let chapters = rendition.getChapter();
        let flattenChapters = rendition.flatChapter(chapters);
        this.props.handleHtmlBook({
          key: this.props.currentBook.key,
          chapters,
          flattenChapters,
          rendition: rendition,
        });
      }, 1000);
    }
  };

  handleLocation = () => {
    if (!this.props.htmlBook) {
      return;
    }
    let position = this.props.htmlBook.rendition.getPosition();
    ConfigService.setObjectConfig(
      this.props.currentBook.key,
      position,
      "recordLocation"
    );
  };
  bindMobileBodyTap = (doc: Document) => {
    if (this.readerTapDocs.has(doc)) return;
    this.readerTapDocs.add(doc);
    const signal = this.readerTapAbort.signal;
    type Sample = { id: number; x: number; y: number; at: number };
    let start: Sample | null = null;
    let active = 0;
    let pending: { x: number; y: number; at: number } | null = null;
    const blocked = (target: EventTarget | null) =>
      (target as Element | null)?.closest?.("a,button,input,select,textarea,summary,video,audio,label,[role=button],[contenteditable]") ||
      doc.getSelection()?.toString().trim() ||
      document.querySelector('.mobile-reader:not([data-reader-panel="none"])');
    const canPage = () => {
      const format = this.props.currentBook.format.toUpperCase();
      return isAndroid() && this.props.readerMode !== "scroll" &&
        ["EPUB", "TXT", "MD", "FB2", "MOBI", "AZW", "AZW3", "DOCX"].includes(format);
    };
    const turn = async (forward: boolean) => {
      const book = this.props.htmlBook;
      if (!book || book.key !== this.props.currentBook.key || this.mobilePageTurning) return;
      this.mobilePageTurning = true;
      try {
        if (forward) await book.rendition.next();
        else await book.rendition.prev();
        if (this.props.htmlBook === book) this.handleLocation();
      } catch (error) {
        console.warn("Mobile page turn failed", error);
      } finally {
        this.mobilePageTurning = false;
      }
    };
    doc.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch") return;
      active++;
      pending = null;
      start = active === 1 && event.isPrimary && !blocked(event.target)
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, at: Date.now() }
        : null;
    }, { passive: true, signal });
    doc.addEventListener("pointercancel", (event) => {
      if (event.pointerType !== "touch") return;
      active = Math.max(0, active - 1);
      start = null;
      pending = null;
    }, { passive: true, signal });
    doc.addEventListener("pointerup", (event) => {
      if (event.pointerType !== "touch") return;
      active = Math.max(0, active - 1);
      const origin = start;
      start = null;
      if (!origin || origin.id !== event.pointerId || active || blocked(event.target)) return;
      const dx = event.clientX - origin.x;
      const dy = event.clientY - origin.y;
      const elapsed = Date.now() - origin.at;
      const width = doc.defaultView?.innerWidth || 0;
      if (!width || origin.x < 24 || origin.x > width - 24) return;
      if (canPage() && elapsed < 700 && Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        void turn(dx < 0);
      } else if (elapsed < 350 && Math.hypot(dx, dy) < 10) {
        pending = { x: event.clientX, y: event.clientY, at: Date.now() };
      }
    }, { passive: true, signal });
    doc.addEventListener("click", (event) => {
      const tap = pending;
      pending = null;
      if (!tap || Date.now() - tap.at > 450 || event.defaultPrevented || blocked(event.target)) return;
      const frame = doc.defaultView?.frameElement;
      const viewport = document.getElementById("page-area")?.getBoundingClientRect();
      const rect = frame?.getBoundingClientRect();
      if (rect && viewport && frame?.ownerDocument === document) {
        const top = Math.max(0, rect.top, viewport.top);
        const left = Math.max(0, rect.left, viewport.left);
        const bottom = Math.min(window.innerHeight, rect.bottom, viewport.bottom);
        const right = Math.min(window.innerWidth, rect.right, viewport.right);
        const x = rect.left + tap.x;
        const y = rect.top + tap.y;
        if (right <= left || bottom <= top || x < left || x > right || y < top || y > bottom) return;
        const fraction = (x - left) / (right - left);
        if (fraction >= 0.25 && fraction <= 0.75) this.props.onMobileBodyTap?.();
        else if (canPage()) void turn(fraction > 0.75);
        return;
      }
      const width = doc.defaultView?.innerWidth || 0;
      const height = doc.defaultView?.innerHeight || 0;
      if (!width || !height || tap.y < height * 0.1 || tap.y > height * 0.9) return;
      if (tap.x >= width * 0.25 && tap.x <= width * 0.75) this.props.onMobileBodyTap?.();
      else if (canPage()) void turn(tap.x > width * 0.75);
    }, { signal });
  };
  handleBindGesture = () => {
    let docs = getIframeDoc(
      this.props.currentBook.format,
      this.props.currentBook.key
    );
    for (let i = 0; i < docs.length; i++) {
      let doc = docs[i];
      if (!doc) continue;
      if (this.props.onMobileBodyTap) {
        this.bindMobileBodyTap(doc);
      } else doc.addEventListener("click", () => {
        this.props.handleLeaveReader("left");
        this.props.handleLeaveReader("right");
        this.props.handleLeaveReader("top");
        this.props.handleLeaveReader("bottom");
      });
      doc.addEventListener("pointerup", (event) => {
        if (
          this.props.currentBook.format === "PDF" &&
          !ConfigService.getAllListConfig("convertPDFBooks").includes(
            this.props.currentBook.key
          )
        ) {
          let ownerDoc = (event.target as HTMLElement).ownerDocument;
          let targetIframe = ownerDoc?.defaultView?.frameElement;
          let id = targetIframe?.getAttribute("id") || "";
          let chapterDocIndex = id ? parseInt(id.split("-").reverse()[0]) : 0;
          this.setState({ chapterDocIndex });
        }

        if (this.state.isDisablePopup) {
          if (doc!.getSelection()!.toString().trim().length === 0) {
            let rect = doc!
              .getSelection()!
              .getRangeAt(0)
              .getBoundingClientRect();
            this.setState({ rect });
          }
        }
        if (this.state.isDisablePopup) return;
        let selection = doc!.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        var rect = selection.getRangeAt(0).getBoundingClientRect();
        this.setState({ rect });
      });
      doc.addEventListener("contextmenu", (event) => {
        if (
          this.props.currentBook.format === "PDF" &&
          !ConfigService.getAllListConfig("convertPDFBooks").includes(
            this.props.currentBook.key
          )
        ) {
          let ownerDoc = (event.target as HTMLElement).ownerDocument;
          let targetIframe = ownerDoc?.defaultView?.frameElement;
          let id = targetIframe?.getAttribute("id") || "";
          let chapterDocIndex = id ? parseInt(id.split("-").reverse()[0]) : 0;
          this.setState({ chapterDocIndex });
        }
        if (document.location.href.indexOf("localhost") === -1) {
          event.preventDefault();
        }

        if (!this.state.isDisablePopup && !this.state.isTouch) return;

        if (
          !doc!.getSelection() ||
          doc!.getSelection()!.toString().trim().length === 0
        ) {
          return;
        }
        let selection = doc!.getSelection();

        if (!selection || selection.rangeCount === 0) return;
        var rect = selection.getRangeAt(0).getBoundingClientRect();
        this.setState({ rect });
      });
    }
  };
  render() {
    return (
      <>
        {this.props.htmlBook ? (
          <PopupMenu
            {...({
              rendition: this.props.htmlBook.rendition,
              rect: this.state.rect,
              chapterDocIndex: this.state.chapterDocIndex,
              chapter: this.state.chapter,
            } as any)}
          />
        ) : null}
        {this.props.htmlBook ? (
          <PopupRefer
            {...({
              rendition: this.props.htmlBook.rendition,
              chapterDocIndex: this.state.chapterDocIndex,
            } as any)}
          />
        ) : null}
        {this.props.htmlBook &&
        (this.props.isDockedRight ||
          (this.props.isOpenMenu &&
            (this.props.menuMode === "dict" ||
              this.props.menuMode === "trans" ||
              this.props.menuMode === "assistant" ||
              this.props.menuMode === "note"))) ? (
          <PopupBox
            {...({
              rendition: this.props.htmlBook.rendition,
              rect: this.state.rect,
              chapterDocIndex: this.state.chapterDocIndex,
              chapter: this.state.chapter,
            } as any)}
          />
        ) : null}
        {this.props.htmlBook && this.props.currentBook.format !== "PDF" && (
          <ImageViewer
            {...({
              isShow: this.props.isShow,
              rendition: this.props.htmlBook.rendition,
              handleEnterReader: this.props.handleEnterReader,
              handleLeaveReader: this.props.handleLeaveReader,
            } as any)}
          />
        )}
        <div
          className={
            this.props.readerMode === "scroll"
              ? "html-viewer-page scrolling-html-viewer-page"
              : "html-viewer-page"
          }
          id="page-area"
          style={
            this.props.readerMode === "scroll" &&
            document.body.clientWidth >= 570
              ? {
                  // marginLeft: this.state.pageOffset,
                  // marginRight: this.state.pageOffset,
                  paddingLeft: "0px",
                  paddingRight: "0px",
                  left: this.state.pageOffset,
                  width: this.state.pageWidth,
                }
              : {
                  left: this.state.pageOffset,
                  width: this.state.pageWidth,
                }
          }
        ></div>
        <PageWidget />
        {this.props.isHideBackground ? null : this.props.currentBook.key ? (
          <Background />
        ) : null}
      </>
    );
  }
}
export default withRouter(Viewer as any);
