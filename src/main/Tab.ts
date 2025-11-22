import { NativeImage, WebContentsView } from "electron";

export class Tab {
  private webContentsView: WebContentsView;
  private _id: string;
  private _title: string;
  private _url: string;
  private _isVisible: boolean = false;

  constructor(id: string, url: string = "https://www.google.com") {
    this._id = id;
    this._url = url;
    this._title = "New Tab";

    // Create the WebContentsView for web content only
    this.webContentsView = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false, // CRITICAL: Allow background tabs to load fully
      },
    });

    // Set up event listeners
    this.setupEventListeners();

    // Load the initial URL
    this.loadURL(url);
  }

  private setupEventListeners(): void {
    // Update title when page title changes
    this.webContentsView.webContents.on("page-title-updated", (_, title) => {
      this._title = title;
    });

    // Update URL when navigation occurs
    this.webContentsView.webContents.on("did-navigate", (_, url) => {
      this._url = url;
    });

    this.webContentsView.webContents.on("did-navigate-in-page", (_, url) => {
      this._url = url;
    });

    // Handle unhandled navigation failures gracefully
    this.webContentsView.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      // Only log if it's not a blocked resource (ads, tracking, etc.)
      if (errorCode !== -27 && errorCode !== -106 && errorCode !== -3) {
        // Check if it's an ad/tracking URL
        if (validatedURL && (
          validatedURL.includes('adx') || 
          validatedURL.includes('analytics') || 
          validatedURL.includes('tracking') ||
          validatedURL.includes('pixel') ||
          validatedURL.includes('doubleclick') ||
          validatedURL.includes('googletagmanager')
        )) {
          // Silently ignore ad/tracking failures
          return;
        }
        
        // Log other failures but don't throw (they're handled in loadURL)
        if (errorCode !== -118) { // Don't log timeouts for non-critical resources
          console.warn(`⚠️  Navigation failure: ${errorDescription} (code: ${errorCode}) for ${validatedURL}`);
        }
      }
    });

    // Handle unhandled promise rejections from navigation
    this.webContentsView.webContents.on("unresponsive", () => {
      console.warn(`⚠️  Tab ${this.id} became unresponsive`);
    });

    this.webContentsView.webContents.on("responsive", () => {
      console.log(`✅ Tab ${this.id} became responsive again`);
    });
  }

  // Getters
  get id(): string {
    return this._id;
  }

  get title(): string {
    return this._title;
  }

  get url(): string {
    return this._url;
  }

  get isVisible(): boolean {
    return this._isVisible;
  }

  get webContents() {
    return this.webContentsView.webContents;
  }

  get view(): WebContentsView {
    return this.webContentsView;
  }

  // Public methods
  show(): void {
    this._isVisible = true;
    this.webContentsView.setVisible(true);
  }

  hide(): void {
    this._isVisible = false;
    this.webContentsView.setVisible(false);
  }

  async screenshot(): Promise<NativeImage> {
    return await this.webContentsView.webContents.capturePage();
  }

  async runJs(code: string): Promise<any> {
    return await this.webContentsView.webContents.executeJavaScript(code);
  }

  async getTabHtml(): Promise<string> {
    return await this.runJs("document.documentElement.outerHTML");
  }

  async getTabText(): Promise<string> {
    return await this.runJs("document.documentElement.innerText");
  }

  async loadURL(url: string): Promise<void> {
    this._url = url;

    // Create promise that resolves when page finishes loading
    const loadPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Navigation timeout for ${url}`));
      }, 30000); // 30 second timeout

      // Listen for load completion
      const onFinishLoad = () => {
        clearTimeout(timeout);
        this.webContentsView.webContents.removeListener('did-finish-load', onFinishLoad);
        this.webContentsView.webContents.removeListener('did-fail-load', onFailLoad);
        resolve();
      };

      const onFailLoad = (_event: any, errorCode: number, errorDescription: string, validatedURL: string) => {
        clearTimeout(timeout);
        this.webContentsView.webContents.removeListener('did-finish-load', onFinishLoad);
        this.webContentsView.webContents.removeListener('did-fail-load', onFailLoad);

        // Ignore aborted navigations (happens when user navigates away quickly)
        if (errorCode === -3) {
          resolve();
          return;
        }

        // Ignore blocked responses (ads, tracking, etc.) - these are not critical failures
        if (errorCode === -27 || errorCode === -106) {
          console.warn(`⚠️  Blocked resource load: ${validatedURL} (code: ${errorCode}) - This is normal for ads/tracking`);
          resolve();
          return;
        }

        // Ignore connection timeouts for non-main resources (ads, analytics, etc.)
        if (errorCode === -118 && validatedURL && (
          validatedURL.includes('adx') || 
          validatedURL.includes('analytics') || 
          validatedURL.includes('tracking') ||
          validatedURL.includes('pixel')
        )) {
          console.warn(`⚠️  Timeout loading resource: ${validatedURL} (code: ${errorCode}) - This is normal for ads/tracking`);
          resolve();
          return;
        }

        reject(new Error(`Navigation failed: ${errorDescription} (code: ${errorCode})`));
      };

      this.webContentsView.webContents.once('did-finish-load', onFinishLoad);
      this.webContentsView.webContents.once('did-fail-load', onFailLoad);
    });

    // Start navigation
    await this.webContentsView.webContents.loadURL(url);

    // Wait for it to complete
    await loadPromise;

    console.log(`✅ Tab ${this.id} finished loading: ${url}`);
  }

  goBack(): void {
    if (this.webContentsView.webContents.navigationHistory.canGoBack()) {
      this.webContentsView.webContents.navigationHistory.goBack();
    }
  }

  goForward(): void {
    if (this.webContentsView.webContents.navigationHistory.canGoForward()) {
      this.webContentsView.webContents.navigationHistory.goForward();
    }
  }

  reload(): void {
    this.webContentsView.webContents.reload();
  }

  stop(): void {
    this.webContentsView.webContents.stop();
  }

  destroy(): void {
    this.webContentsView.webContents.close();
  }
}
