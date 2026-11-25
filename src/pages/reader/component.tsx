import React from "react";
import SettingPanel from "../../containers/panels/settingPanel";
import NavigationPanel from "../../containers/panels/navigationPanel";
import OperationPanel from "../../containers/panels/operationPanel";
import { Toaster } from "react-hot-toast";
import ProgressPanel from "../../containers/panels/progressPanel";
import { ReaderProps, ReaderState } from "./interface";
import {
  ConfigService,
  ReadingTimeUtil,
} from "../../assets/lib/kookit-extra-browser.min";
import Viewer from "../../containers/viewer";
import { Tooltip } from "react-tooltip";
import "./index.css";
import Book from "../../models/Book";
import DatabaseService from "../../utils/storage/databaseService";
import ConvertDialog from "../../components/dialogs/convertDialog";
import PdfCropDialog from "../../components/dialogs/pdfCropDialog";
import { isElectron } from "react-device-detect";
import SettingDialog from "../../components/dialogs/settingDialog";
import SpeechDialog from "../../components/dialogs/speechDialog";
import AnnotationDialog from "../../components/dialogs/annotationDialog";
import PopupOptionDialog from "../../components/dialogs/popupOptionDialog";
import {
  updateDiscordPresence,
  clearDiscordPresence,
} from "../../utils/reader/discordRPC";
import {
  READING_PANEL_OPEN_EVENT,
  READING_PANEL_TOGGLE_EVENT,
} from "../../utils/reader/mouseEvent";
import { isAndroid, isCapacitor, isMobileDevice } from "../../platform";
import TTSUtil from "../../utils/reader/ttsUtil";
import { bindAndroidReaderBack } from "../../utils/reader/androidReaderNavigation";
import { Trans } from "react-i18next";
import { throttle } from "../../utils/common";
declare var window: any;
let lock = false; //prevent from clicking too fasts
let throttleTime = 200;
let isMouseMoving = false;
const PANEL_POSITIONS = ["left", "right", "top", "bottom"] as const;
type PanelPosition = (typeof PANEL_POSITIONS)[number];
const PANEL_ENTER_DELAY = 500;
const PANEL_LEAVE_DELAY = 500;
const enterTimers: Record<string, NodeJS.Timeout | null> = {
  left: null,
  right: null,
  top: null,
  bottom: null,
};
const leaveTimers: Record<string, NodeJS.Timeout | null> = {
  left: null,
  right: null,
  top: null,
  bottom: null,
};
const isEdgeHovering: Record<string, boolean> = {
  left: false,
  right: false,
  top: false,
  bottom: false,
};
const PANEL_OPEN_STATE: Record<
  PanelPosition,
  | "isOpenLeftPanel"
  | "isOpenRightPanel"
  | "isOpenTopPanel"
  | "isOpenBottomPanel"
> = {
  left: "isOpenLeftPanel",
  right: "isOpenRightPanel",
  top: "isOpenTopPanel",
  bottom: "isOpenBottomPanel",
};
type MobilePanel = PanelPosition | "tools";
const MOBILE_PANEL_LABEL: Record<MobilePanel, string> = {
  left: "Contents",
  bottom: "Progress",
  right: "Settings",
  top: "Reading Options",
  tools: "More",
};
type ReaderComponentProps = ReaderProps & {
    mobilePopupOpen?: boolean;
    handleSetting: (open: boolean) => void;
    handleSettingMode: (mode: string) => void;
    handlePopupOptionDialog: (open: boolean) => void;
};
class Reader extends React.Component<
  ReaderComponentProps,
  ReaderState & { mobileChrome: boolean; mobilePanel: MobilePanel | null }
> {
  private readonly mobileReader = isCapacitor();
  private androidBack?: ReturnType<typeof bindAndroidReaderBack>;
  messageTimer!: NodeJS.Timeout;
  tickTimer!: NodeJS.Timeout;
  private autoShowTimer: NodeJS.Timeout | null = null;
  private readingTimeUtil = new ReadingTimeUtil(
    ConfigService,
    isElectron
      ? {
          registerUnloadHandler(callback: () => void): () => void {
            const ipcRenderer = window.electronAPI;
            // Separate reader window close
            ipcRenderer.on("before-reader-close", callback);
            // In-app tab (WebContentsView) close
            ipcRenderer.on("before-tab-close", callback);
            return () => {
              ipcRenderer.removeListener("before-reader-close", callback);
              ipcRenderer.removeListener("before-tab-close", callback);
            };
          },
          onBeforeClose(): void {
            const ipcRenderer = window.electronAPI;
            // Reply to whichever close signal is active
            ipcRenderer.send("reader-close-ready");
            ipcRenderer.send("tab-close-ready");
          },
        }
      : {
          registerUnloadHandler(callback: () => void): () => void {
            window.addEventListener("beforeunload", callback);
            return () => window.removeEventListener("beforeunload", callback);
          },
        }
  );
  constructor(props: ReaderComponentProps) {
    super(props);
    this.state = {
      isOpenTopPanel: false,
      isOpenBottomPanel: false,
      hoverPanel: "",
      isOpenLeftPanel: this.props.isNavLocked,
      isOpenRightPanel: this.props.isSettingLocked,
      totalDuration: 0,
      currentDuration: 0,
      scale: ConfigService.getReaderConfig("scale") || "1",
      isTouch: ConfigService.getReaderConfig("isTouch") === "yes",
      isPreventTrigger:
        ConfigService.getReaderConfig("isPreventTrigger") === "yes",
      isShowScale: false,
      isNearEdge: false,
      mobileChrome: false,
      mobilePanel: null,
    };
  }
  componentDidMount() {
    if (isAndroid()) {
      this.androidBack = bindAndroidReaderBack(this.closeReaderLayer, this.prepareReaderExit);
    }
    if (ConfigService.getReaderConfig("isMergeWord") === "yes") {
      document
        .querySelector("body")
        ?.setAttribute("style", "background-color: rgba(0,0,0,0)");
    }

    // Update UI counters every second so the navigation panel still shows
    // live reading-time values, but actual storage writes only happen when
    // a reading session ends (visibility hidden / blur / unmount).
    this.tickTimer = setInterval(() => {
      if (!this.props.currentBook.key) return;
      this.setState((prev) => ({
        totalDuration: prev.totalDuration + 60,
        currentDuration: prev.currentDuration + 60,
      }));
    }, 60000);

    window.addEventListener("beforeunload", function (event) {
      if (!isElectron) {
        ConfigService.setReaderConfig("isFinishWebReading", "yes");
      }
    });
    const handleMouseMove = () => {
      isMouseMoving = true;
      setTimeout(() => {
        isMouseMoving = false;
      }, 100);
    };
    const throttledMouseMove = throttle(handleMouseMove, 100);
    window.addEventListener("mousemove", throttledMouseMove);
    if (this.mobileReader) {
      window.addEventListener(READING_PANEL_OPEN_EVENT, this.openMobilePanel);
    }
    window.addEventListener(
      READING_PANEL_TOGGLE_EVENT,
      this.handleReadingPanelToggle
    );

    // 进入阅读器后主动展示快捷按钮 3 秒，提示用户位置后自动隐藏
    this.setState({ isNearEdge: true });
    this.autoShowTimer = setTimeout(() => {
      this.autoShowTimer = null;
      this.setState({ isNearEdge: false });
    }, 1500);
  }
  async UNSAFE_componentWillMount() {
    let url = document.location.href;
    let firstIndexOfQuestion = url.indexOf("?");
    let lastIndexOfSlash = url.lastIndexOf("/", firstIndexOfQuestion);
    let key = url.substring(lastIndexOfSlash + 1, firstIndexOfQuestion);
    if (ConfigService.getAllListConfig("seperateStyleBooks").includes(key)) {
      window.currentBookKey = key;
      this.props.handleBackgroundColor(
        ConfigService.getReaderConfig("backgroundColor") || ""
      );
    } else {
      window.currentBookKey = "";
    }
    this.props.handleFetchBooks();
    this.props.handleFetchAuthed();
    if (
      key &&
      ConfigService.getAllListConfig("convertPDFBooks").includes(key) &&
      ConfigService.getReaderConfig(
        this.props.currentBook?.description?.indexOf("scanned") > -1
          ? "scannedOcrEngine"
          : "textOcrEngine"
      ) === "official-ai-ocr"
    ) {
      await this.props.handleFetchUserInfo();
    }
    DatabaseService.getRecord(key, "books").then((book: Book | null) => {
      book = book || JSON.parse(ConfigService.getItem("tempBook") || "{}");
      if (!book) return;

      this.props.handleFetchPercentage(book);
      // Phones in portrait get single-page by default: the desktop
      // double-page spread leaves each column unreadably narrow.
      let readerMode =
        (book.format === "PDF" &&
          !ConfigService.getAllListConfig("convertPDFBooks").includes(
            book.key
          )) ||
        book.format.startsWith("CB")
          ? ConfigService.getReaderConfig("pdfReaderMode") || "scroll"
          : ConfigService.getReaderConfig("readerMode") ||
            (isMobileDevice() ? "single" : "double");
      this.props.handleReaderMode(readerMode);
      this.props.handleReadingBook(book);
      // Start event-driven reading-time tracking
      this.readingTimeUtil.start(book.key);
      // Initialise UI duration from persisted total
      const savedTotal = this.readingTimeUtil.getTotalSeconds(book.key);
      this.setState({ totalDuration: savedTotal, currentDuration: 0 });
      if (isElectron) {
        updateDiscordPresence(book);
      }
    });
  }

  componentWillUnmount() {
    this.androidBack?.dispose();
    window.removeEventListener(READING_PANEL_OPEN_EVENT, this.openMobilePanel);
    window.removeEventListener(
      READING_PANEL_TOGGLE_EVENT,
      this.handleReadingPanelToggle
    );
    if (isElectron) {
      clearDiscordPresence();
    }
    clearInterval(this.tickTimer);
    if (this.autoShowTimer) {
      clearTimeout(this.autoShowTimer);
      this.autoShowTimer = null;
    }
    PANEL_POSITIONS.forEach((position) => {
      this.cancelEnterReader(position);
      this.cancelLeaveReader(position);
    });
    // Flush any in-flight session time before the component tears down
    this.readingTimeUtil.stop();
  }

  cancelEnterReader = (position: string) => {
    isEdgeHovering[position] = false;
    if (enterTimers[position]) {
      clearTimeout(enterTimers[position]!);
      enterTimers[position] = null;
    }
  };

  scheduleEnterReader = (position: string) => {
    this.cancelEnterReader(position);
    isEdgeHovering[position] = true;
    const delay = this.state.isPreventTrigger ? 0 : PANEL_ENTER_DELAY;
    enterTimers[position] = setTimeout(() => {
      enterTimers[position] = null;
      if (!isEdgeHovering[position] || isMouseMoving) return;
      this.handleEnterReader(position);
    }, delay);
  };

  cancelLeaveReader = (position: string) => {
    if (leaveTimers[position]) {
      clearTimeout(leaveTimers[position]!);
      leaveTimers[position] = null;
    }
  };

  scheduleLeaveReader = (position: string) => {
    if (this.mobileReader) return;
    this.cancelLeaveReader(position);
    leaveTimers[position] = setTimeout(() => {
      leaveTimers[position] = null;
      this.handleLeaveReader(position);
    }, PANEL_LEAVE_DELAY);
  };

  handleEdgeMouseEnter = (position: PanelPosition) => {
    if (
      this.state.isTouch ||
      this.state[PANEL_OPEN_STATE[position]] ||
      this.state.isPreventTrigger
    ) {
      this.cancelLeaveReader(position);
      this.setState({ hoverPanel: position });
      return;
    }
    this.scheduleEnterReader(position);
  };

  handleEdgeMouseLeave = (position: PanelPosition) => {
    this.cancelEnterReader(position);
    this.setState({ hoverPanel: "" });
  };

  closeReaderLayer = () => {
    if (this.props.isOpenPopupOptionDialog) this.props.handlePopupOptionDialog(false);
    else if (this.props.isSettingOpen) {
      this.props.handleSetting(false);
      this.props.handleSettingMode("general");
    } else if (this.props.isConvertOpen) this.props.handleConvertDialog(false);
    else if (this.props.isPdfCropOpen) this.props.handlePdfCropDialog(false);
    else if (this.props.isAnnotationOpen) {
      this.props.htmlBook?.rendition.applyAnnotationConfig({ isDrawing: "no" });
      this.props.handleAnnotationDialog(false);
    } else if (this.props.isSpeechOpen) this.props.handleSpeechDialog(false);
    else if (this.props.mobilePopupOpen) this.props.handleOpenMenu(false);
    else if (this.state.mobilePanel) this.closeMobilePanel();
    else return false;
    return true;
  };
  prepareReaderExit = () => {
    const { currentBook, htmlBook } = this.props;
    try {
      if (currentBook.key && htmlBook?.key === currentBook.key) {
        const position = htmlBook.rendition.getPosition();
        if (position && typeof position === "object") {
          ConfigService.setObjectConfig(currentBook.key, position, "recordLocation");
        }
      }
    } finally {
      this.readingTimeUtil.stop();
      window.speechSynthesis?.cancel();
      void TTSUtil.stopAudio();
    }
  };
  openMobilePanel = (event: Event) => {
    const detail = (event as CustomEvent<{
      position: PanelPosition;
      onOpen?: () => void;
    }>).detail;
    if (!detail || !PANEL_POSITIONS.includes(detail.position)) return;
    event.preventDefault();
    this.setState(
      { mobileChrome: true, mobilePanel: detail.position },
      () => detail.onOpen?.()
    );
  };
  showMobilePanel = (position: MobilePanel) => {
    this.setState((state) => ({
      mobileChrome: true,
      mobilePanel: state.mobilePanel === position ? null : position,
    }));
  };
  closeMobilePanel = () => this.setState({ mobilePanel: null });
  turnMobilePage = async (forward: boolean) => {
    const book = this.props.htmlBook;
    if (!book || book.key !== this.props.currentBook.key || lock) return;
    lock = true;
    try {
      if (forward) await book.rendition.next();
      else await book.rendition.prev();
      if (this.props.htmlBook === book) this.handleLocation();
    } catch (error) {
      console.warn("Mobile page turn failed", error);
    } finally {
      lock = false;
    }
  };
  toggleMobileChrome = () => {
    if (
      !this.mobileReader ||
      this.props.isSettingOpen ||
      this.props.isConvertOpen ||
      this.props.isPdfCropOpen ||
      this.props.isSpeechOpen ||
      this.props.isAnnotationOpen ||
      this.props.isOpenPopupOptionDialog
    ) return;
    this.setState((state) => ({
      mobilePanel: null,
      mobileChrome: state.mobilePanel ? true : !state.mobileChrome,
    }));
  };
  handleEnterReader = (position: string) => {
    if (this.mobileReader && PANEL_POSITIONS.includes(position as PanelPosition)) {
      this.setState({ mobileChrome: true, mobilePanel: position as PanelPosition });
      return;
    }
    this.cancelEnterReader(position);
    this.cancelLeaveReader(position);
    switch (position) {
      case "right":
        this.setState({
          isOpenRightPanel: true,
        });
        break;
      case "left":
        this.setState({
          isOpenLeftPanel: true,
        });
        break;
      case "top":
        this.setState({
          isOpenTopPanel: true,
        });
        break;
      case "bottom":
        this.setState({
          isOpenBottomPanel: true,
        });
        break;
      default:
        break;
    }
  };
  handleLeaveReader = (position: string) => {
    if (this.mobileReader) {
      if (this.state.mobilePanel === position) this.closeMobilePanel();
      return;
    }
    this.cancelLeaveReader(position);
    switch (position) {
      case "right":
        if (this.props.isSettingLocked) {
          break;
        } else {
          this.setState({ isOpenRightPanel: false });
          break;
        }

      case "left":
        if (
          this.props.isNavLocked ||
          ConfigService.getReaderConfig("isTempLocked") === "yes"
        ) {
          break;
        } else {
          this.setState({ isOpenLeftPanel: false });
          break;
        }
      case "top":
        this.setState({ isOpenTopPanel: false });
        break;
      case "bottom":
        this.setState({ isOpenBottomPanel: false });
        break;
      default:
        break;
    }
  };
  handleReadingPanelToggle = (event: Event) => {
    const position = (event as CustomEvent<{ position: string }>).detail
      ?.position;
    if (!PANEL_POSITIONS.includes(position as PanelPosition)) return;
    if (this.mobileReader) {
      this.showMobilePanel(position as PanelPosition);
      return;
    }
    const stateKey = PANEL_OPEN_STATE[position as PanelPosition];
    if (this.state[stateKey]) {
      this.handleLeaveReader(position);
    } else {
      this.handleEnterReader(position);
    }
  };
  handleLocation = () => {
    let position = this.props.htmlBook.rendition.getPosition();

    ConfigService.setObjectConfig(
      this.props.currentBook.key,
      position,
      "recordLocation"
    );
  };
  render() {
    const renditionProps = {
      onMobileBodyTap: this.mobileReader ? this.toggleMobileChrome : undefined,
      handleLeaveReader: this.handleLeaveReader,
      handleEnterReader: this.handleEnterReader,
      isShow: this.mobileReader
        ? this.state.mobilePanel !== null
        : this.state.isOpenLeftPanel || this.state.isOpenTopPanel ||
          this.state.isOpenBottomPanel || this.state.isOpenRightPanel,
    };
    return (
      <div
        className={this.mobileReader ? "viewer mobile-reader" : "viewer"}
        data-reader-panel={this.mobileReader ? this.state.mobilePanel || "none" : undefined}
      >
        {this.mobileReader && !this.state.mobileChrome && !this.state.mobilePanel && (
          <button type="button" className="mobile-reader-reveal" aria-label={this.props.t("More")}
            onClick={() => this.setState({ mobileChrome: true })}>
            <span aria-hidden="true">···</span>
          </button>
        )}
        {this.mobileReader && this.state.mobileChrome && !this.state.mobilePanel && (
          <>
            <header className="mobile-reader-topbar">
              {isAndroid() && (
                <button type="button" aria-label={this.props.t("Back")}
                  onClick={() => this.androidBack?.back()}><span aria-hidden="true">‹</span></button>
              )}
              <span className="mobile-reader-book-title">{this.props.currentBook.name}</span>
              <button type="button" aria-label={this.props.t("More")}
                onClick={() => this.showMobilePanel("top")}><span aria-hidden="true">···</span></button>
            </header>
            <nav className="mobile-reader-bottombar">
              {([
                ["left", "≡"], ["bottom", "⇥"], ["right", "Aa"], ["tools", "···"],
              ] as const).map(([position, icon]) => (
                <button type="button" key={position}
                  aria-expanded={this.state.mobilePanel === position}
                  onClick={() => this.showMobilePanel(position)}>
                  <span aria-hidden="true">{icon}</span>
                  <span><Trans>{MOBILE_PANEL_LABEL[position]}</Trans></span>
                </button>
              ))}
            </nav>
          </>
        )}
        {this.mobileReader && this.state.mobilePanel && (
          <>
            <div className="mobile-reader-scrim" onClick={this.closeMobilePanel} />
            <div className="mobile-reader-sheet-header">
              <strong><Trans>{MOBILE_PANEL_LABEL[this.state.mobilePanel]}</Trans></strong>
              <button type="button" aria-label={this.props.t("Close")} onClick={this.closeMobilePanel}>
                <span aria-hidden="true">×</span>
              </button>
            </div>
          </>
        )}
        <Tooltip id="my-tooltip" style={{ zIndex: 25 }} />

        <div className="mobile-reader-tools">
        <div
          className="previous-chapter-single-container"
          onClick={async () => {
            if (lock) return;
            lock = true;
            await this.props.htmlBook.rendition.prev();
            this.handleLocation();
            setTimeout(() => (lock = false), throttleTime);
          }}
          style={{
            left: this.props.isNavLocked ? 315 : 15,
            opacity: this.state.isNearEdge ? undefined : 0,
            transition: "opacity 0.3s ease",
          }}
          onMouseEnter={() => this.setState({ isNearEdge: true })}
          onMouseLeave={() => this.setState({ isNearEdge: false })}
        >
          <span className="icon-dropdown previous-chapter-single"></span><span className="mobile-reader-tool-label"><Trans>Previous Page</Trans></span>
        </div>
        <div
          className="mobile-reader-tool-row"
          style={{
            position: "absolute",
            bottom: 10,
            right:
              this.props.isSettingLocked || this.props.isDockedRight ? 315 : 15,
            display: "flex",
            flexDirection: "column-reverse",
            alignItems: "center",
            gap: "8px",
            zIndex: 10,
            opacity: this.state.isNearEdge ? 1 : 0,
            transition: "opacity 0.3s ease",
          }}
          onMouseEnter={() => this.setState({ isNearEdge: true })}
          onMouseLeave={() => this.setState({ isNearEdge: false })}
        >
          <div
            className="next-chapter-single-container"
            onClick={async () => {
              if (lock) return;
              lock = true;
              await this.props.htmlBook.rendition.next();
              this.handleLocation();
              setTimeout(() => (lock = false), throttleTime);
            }}
            style={{ position: "static" }}
          >
            <span className="icon-dropdown next-chapter-single"></span><span className="mobile-reader-tool-label"><Trans>Next Page</Trans></span>
          </div>
          <div
            className="next-chapter-single-container"
            onClick={async () => {
              this.props.handleSpeechDialog(!this.props.isSpeechOpen);
            }}
            style={{ position: "static", transform: "rotate(0deg)" }}
          >
            <span
              style={
                this.props.isSpeechOpen
                  ? { fontWeight: "bold", marginTop: "4px" }
                  : {}
              }
              className={`icon-${this.props.isSpeechOpen ? "close" : "earphone"} next-chapter-single`}
            ></span><span className="mobile-reader-tool-label"><Trans>Text to Speech</Trans></span>
          </div>
          {ConfigService.getReaderConfig("isDisableAI") !== "yes" && (
            <div
              className="next-chapter-single-container"
              onClick={async () => {
                this.props.handleMenuMode("assistant");
                this.props.handleOriginalText(
                  await this.props.htmlBook.rendition.chapterText()
                );
                this.props.handleOpenMenu(true);
              }}
              style={{
                position: "static",
                transform: "rotate(0deg)",
                fontWeight: "bold",
                fontSize: "17px",
              }}
            >
              AI
            </div>
          )}
          {this.props.currentBook.format === "PDF" &&
            !ConfigService.getAllListConfig("convertPDFBooks").includes(
              this.props.currentBook.key
            ) &&
            this.props.currentBook.description.indexOf("scanned") > -1 && (
              <div
                className="next-chapter-single-container"
                onClick={() => {
                  this.props.htmlBook.rendition.applyAnnotationConfig({
                    isDrawing: this.props.isAnnotationOpen ? "no" : "yes",
                  });
                  this.props.handleAnnotationDialog(
                    !this.props.isAnnotationOpen
                  );
                }}
                style={{ position: "static", transform: "rotate(0deg)" }}
              >
                <span
                  style={
                    this.props.isAnnotationOpen
                      ? { fontWeight: "bold", marginTop: "4px" }
                      : { fontSize: "17px" }
                  }
                  className={`icon-${this.props.isAnnotationOpen ? "close" : "edit"} next-chapter-single`}
                ></span><span className="mobile-reader-tool-label"><Trans>Annotation</Trans></span>
              </div>
            )}
        </div>

        <div
          className="mobile-reader-tool-row"
          style={{
            position: "absolute",
            top: "0px",
            right:
              this.props.isSettingLocked || this.props.isDockedRight ? 300 : 5,
            zIndex: 10,
            width: "120px",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            opacity: this.state.isNearEdge ? 1 : 0,
            transition: "opacity 0.3s ease",
            color: ConfigService.getReaderConfig("textColor")
              ? ConfigService.getReaderConfig("textColor")
              : "",
          }}
          onMouseEnter={() => this.setState({ isNearEdge: true })}
          onMouseLeave={() => this.setState({ isNearEdge: false })}
        >
          {(this.props.readerMode === "scroll" ||
            this.props.readerMode === "single") && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
              }}
            >
              {this.state.isShowScale && (
                <div className="scale-container">
                  <div
                    style={{
                      zIndex: 100,
                      width: "100px",
                    }}
                  >
                    <input
                      className="input-value"
                      defaultValue={
                        ConfigService.getReaderConfig("scale")
                          ? parseFloat(ConfigService.getReaderConfig("scale")) *
                            100
                          : 100
                      }
                      value={
                        this.state.scale === " "
                          ? this.state.scale
                          : Math.round(parseFloat(this.state.scale) * 100)
                      }
                      type="number"
                      onInput={(event: any) => {
                        let fieldVal = event.target.value;
                        ConfigService.setReaderConfig(
                          "scale",
                          parseFloat(fieldVal) / 100 + ""
                        );
                      }}
                      onFocus={() => {
                        this.setState({ scale: " " });
                      }}
                      onChange={(event) => {
                        let fieldVal = event.target.value;
                        this.setState({
                          scale: parseFloat(fieldVal) / 100 + "",
                        });
                      }}
                      onBlur={(event) => {
                        let fieldVal = event.target.value;
                        if (fieldVal.trim() !== "") {
                          ConfigService.setReaderConfig(
                            "scale",
                            parseFloat(fieldVal) / 100 + ""
                          );
                        }
                        this.props.renderBookFunc();
                      }}
                    />
                    <span> %</span>
                  </div>

                  <input
                    className="input-progress"
                    value={this.state.scale}
                    type="range"
                    max={4}
                    min={0.5}
                    step={0.01}
                    onInput={(event: any) => {
                      const scale = event.target.value;
                      ConfigService.setReaderConfig("scale", scale);
                    }}
                    onChange={(event) => {
                      this.setState({ scale: event.target.value });
                    }}
                    onMouseUp={() => {
                      this.props.handleScale(this.state.scale);
                      this.props.renderBookFunc();
                    }}
                    style={{
                      zIndex: 100,
                      width: "120px",
                    }}
                  />
                </div>
              )}
              <div
                className="reader-zoom-in-icon-container"
                onClick={() => {
                  this.setState({ isShowScale: !this.state.isShowScale });
                }}
              >
                <span className="icon-zoom-in reader-setting-icon"></span><span className="mobile-reader-tool-label"><Trans>Zoom</Trans></span>
              </div>
            </div>
          )}

          {this.props.currentBook.format === "PDF" &&
            this.props.readerMode === "scroll" && (
              <div
                className="reader-setting-icon-container"
                onClick={() => {
                  this.props.handlePdfCropDialog(!this.props.isPdfCropOpen);
                }}
              >
                <span
                  className="icon-crop reader-setting-icon"
                  style={{ fontSize: 24 }}
                ></span><span className="mobile-reader-tool-label"><Trans>Crop</Trans></span>
              </div>
            )}

          {this.props.currentBook.format === "PDF" && (
            <div
              className="reader-setting-icon-container"
              onClick={() => {
                this.props.handleConvertDialog(!this.props.isConvertOpen);
              }}
            >
              <span
                className="icon-convert-text reader-setting-icon"
                style={{ fontSize: 26 }}
              ></span>
              <span className="mobile-reader-tool-label"><Trans>Convert</Trans></span>
            </div>
          )}
          <div
            className="reader-setting-icon-container mobile-reader-desktop-grid"
            onClick={() => {
              this.handleEnterReader("left");
              this.handleEnterReader("right");
              this.handleEnterReader("bottom");
              this.handleEnterReader("top");
            }}
          >
            <span
              className="icon-grid reader-setting-icon"
              style={{ opacity: 1 }}
            ></span>
          </div>
        </div>
        </div>
        {this.props.isSettingOpen && (
          <>
            <SettingDialog />
            <div className="drag-background"></div>
          </>
        )}
        <Toaster
          toastOptions={{
            style: {
              wordWrap: "break-word",
              wordBreak: "break-word",
              whiteSpace: "normal",
              overflowWrap: "break-word",
            },
          }}
        />

        <div
          className="left-panel"
          onMouseEnter={() => this.handleEdgeMouseEnter("left")}
          onMouseLeave={() => this.handleEdgeMouseLeave("left")}
          style={this.state.hoverPanel === "left" ? { opacity: 0.5 } : {}}
          onClick={() => {
            this.handleEnterReader("left");
          }}
        >
          <span className="icon-grid panel-icon"></span>
        </div>
        <div
          className="right-panel"
          onMouseEnter={() => this.handleEdgeMouseEnter("right")}
          onMouseLeave={() => this.handleEdgeMouseLeave("right")}
          style={
            this.state.hoverPanel === "right"
              ? {
                  opacity: 0.5,
                  right: this.props.isDockedRight ? "299px" : "0px",
                }
              : { right: this.props.isDockedRight ? "299px" : "0px" }
          }
          onClick={() => {
            this.handleEnterReader("right");
          }}
        >
          <span className="icon-grid panel-icon"></span>
        </div>
        <div
          className="top-panel"
          onMouseEnter={() => this.handleEdgeMouseEnter("top")}
          style={
            this.state.hoverPanel === "top"
              ? {
                  opacity: 0.5,
                  marginLeft:
                    this.props.isNavLocked &&
                    !this.props.isSettingLocked &&
                    !this.props.isDockedRight
                      ? 150
                      : 0,
                }
              : {
                  marginLeft:
                    this.props.isNavLocked &&
                    !this.props.isSettingLocked &&
                    !this.props.isDockedRight
                      ? 150
                      : 0,
                }
          }
          onMouseLeave={() => this.handleEdgeMouseLeave("top")}
          onClick={() => {
            this.handleEnterReader("top");
          }}
        >
          <span className="icon-grid panel-icon"></span>
        </div>
        <div
          className="bottom-panel"
          onMouseEnter={() => this.handleEdgeMouseEnter("bottom")}
          onMouseLeave={() => this.handleEdgeMouseLeave("bottom")}
          onClick={() => {
            this.handleEnterReader("bottom");
          }}
          style={
            this.state.hoverPanel === "bottom"
              ? {
                  opacity: 0.5,
                  marginLeft:
                    this.props.isNavLocked &&
                    !this.props.isSettingLocked &&
                    !this.props.isDockedRight
                      ? 150
                      : 0,
                }
              : {
                  marginLeft:
                    this.props.isNavLocked &&
                    !this.props.isSettingLocked &&
                    !this.props.isDockedRight
                      ? 150
                      : 0,
                }
          }
        >
          <span className="icon-grid panel-icon"></span>
        </div>

        <div
          className="setting-panel-container"
          onMouseEnter={() => {
            this.cancelLeaveReader("right");
          }}
          onMouseLeave={() => {
            this.scheduleLeaveReader("right");
          }}
          style={
            this.state.isOpenRightPanel
              ? {}
              : {
                  transform: "translateX(309px)",
                }
          }
        >
          <SettingPanel />
        </div>
        <div
          className="navigation-panel-container"
          onMouseEnter={() => {
            this.cancelLeaveReader("left");
          }}
          onMouseLeave={() => {
            this.scheduleLeaveReader("left");
          }}
          style={
            this.state.isOpenLeftPanel
              ? {}
              : {
                  transform: "translateX(-309px)",
                }
          }
        >
          <NavigationPanel
            {...({
              totalDuration: this.state.totalDuration,
            } as any)}
          />
        </div>
        <div
          className="progress-panel-container"
          onMouseEnter={() => {
            this.cancelLeaveReader("bottom");
          }}
          onMouseLeave={() => {
            this.scheduleLeaveReader("bottom");
          }}
          style={
            this.state.isOpenBottomPanel
              ? {
                  marginLeft:
                    this.props.isNavLocked && !this.props.isSettingLocked
                      ? 150
                      : !this.props.isNavLocked &&
                          (this.props.isSettingLocked ||
                            this.props.isDockedRight)
                        ? -150
                        : 0,
                }
              : {
                  transform: "translateY(110px)",
                  marginLeft:
                    this.props.isNavLocked && !this.props.isSettingLocked
                      ? 150
                      : !this.props.isNavLocked &&
                          (this.props.isSettingLocked ||
                            this.props.isDockedRight)
                        ? -150
                        : 0,
                }
          }
        >
          <ProgressPanel />
          {this.mobileReader && (
            <div className="mobile-reader-page-actions">
              <button type="button" disabled={!this.props.htmlBook} onClick={() => this.turnMobilePage(false)}>
                <Trans>Previous page</Trans>
              </button>
              <button type="button" disabled={!this.props.htmlBook} onClick={() => this.turnMobilePage(true)}>
                <Trans>Next page</Trans>
              </button>
            </div>
          )}
        </div>
        <div
          className="operation-panel-container"
          onMouseEnter={() => {
            this.cancelLeaveReader("top");
          }}
          onMouseLeave={() => {
            this.scheduleLeaveReader("top");
          }}
          style={
            this.state.isOpenTopPanel
              ? {
                  marginLeft:
                    this.props.isNavLocked && !this.props.isSettingLocked
                      ? 150
                      : !this.props.isNavLocked &&
                          (this.props.isSettingLocked ||
                            this.props.isDockedRight)
                        ? -150
                        : 0,
                }
              : {
                  transform: "translateY(-110px)",
                  marginLeft:
                    this.props.isNavLocked && !this.props.isSettingLocked
                      ? 150
                      : !this.props.isNavLocked &&
                          (this.props.isSettingLocked ||
                            this.props.isDockedRight)
                        ? -150
                        : 0,
                }
          }
        >
          {this.props.htmlBook && (
            <OperationPanel
              {...({
                currentDuration: this.state.currentDuration,
              } as any)}
            />
          )}
        </div>

        {this.props.currentBook.key && <Viewer {...(renditionProps as any)} />}
        {this.props.isConvertOpen && <ConvertDialog />}
        {this.props.isPdfCropOpen && <PdfCropDialog />}
        {this.props.isOpenPopupOptionDialog && (
          <>
            <PopupOptionDialog />
            <div className="drag-background"></div>
          </>
        )}
        {
          <div
            style={
              this.props.isSpeechOpen
                ? {}
                : {
                    display: "none",
                  }
            }
          >
            <SpeechDialog />
          </div>
        }
        {this.props.isAnnotationOpen && <AnnotationDialog />}
      </div>
    );
  }
}

export default Reader;
