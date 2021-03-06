import fs from 'fs';
import path from 'path';
import { BrowserWindow, shell, ipcMain, dialog } from 'electron';
import windowStateKeeper from 'electron-window-state';
import helpers from './../../helpers/helpers';
import createMenu from './../menu/menu';
import initContextMenu from './../contextMenu/contextMenu';

const {
  isOSX, linkIsInternal, getCssToInject, shouldInjectCss, getAppIcon, nativeTabsSupported,
} = helpers;

const ZOOM_INTERVAL = 0.1;

function maybeHideWindow(window, event, fastQuit, tray) {
  if (isOSX() && !fastQuit) {
    // this is called when exiting from clicking the cross button on the window
    event.preventDefault();
    window.hide();
  } else if (!fastQuit && tray) {
    event.preventDefault();
    window.hide();
  }
  // will close the window on other platforms
}

function maybeInjectCss(browserWindow) {
  if (!shouldInjectCss()) {
    return;
  }

  const cssToInject = getCssToInject();

  const injectCss = () => {
    browserWindow.webContents.insertCSS(cssToInject);
  };

  browserWindow.webContents.on('did-finish-load', () => {
    // remove the injection of css the moment the page is loaded
    browserWindow.webContents.removeListener('did-get-response-details', injectCss);
  });

  // on every page navigation inject the css
  browserWindow.webContents.on('did-navigate', () => {
    // we have to inject the css in did-get-response-details to prevent the fouc
    // will run multiple times
    browserWindow.webContents.on('did-get-response-details', injectCss);
  });
}


/**
 *
 * @param {{}} inpOptions AppArgs from nativefier.json
 * @param {function} onAppQuit
 * @param {function} setDockBadge
 * @returns {electron.BrowserWindow}
 */
function createMainWindow(inpOptions, onAppQuit, setDockBadge) {
  const options = Object.assign({}, inpOptions);
  const mainWindowState = windowStateKeeper({
    defaultWidth: options.width || 1280,
    defaultHeight: options.height || 800,
  });

  const DEFAULT_WINDOW_OPTIONS = {
    // Convert dashes to spaces because on linux the app name is joined with dashes
    title: options.name,
    tabbingIdentifier: nativeTabsSupported() ? options.name : undefined,
    webPreferences: {
      javascript: true,
      plugins: true,
      // node globals causes problems with sites like messenger.com
      nodeIntegration: false,
      webSecurity: !options.insecure,
      preload: path.join(__dirname, 'static', 'preload.js'),
      zoomFactor: options.zoom,
    },
  };

  const mainWindow = new BrowserWindow(Object.assign({
    frame: !options.hideWindowFrame,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight,
    x: options.x,
    y: options.y,
    autoHideMenuBar: !options.showMenuBar,
    // after webpack path here should reference `resources/app/`
    icon: getAppIcon(),
    // set to undefined and not false because explicitly setting to false will disable full screen
    fullscreen: options.fullScreen || undefined,
    // Whether the window should always stay on top of other windows. Default is false.
    alwaysOnTop: options.alwaysOnTop,
  }, DEFAULT_WINDOW_OPTIONS));

  mainWindowState.manage(mainWindow);

  // after first run, no longer force maximize to be true
  if (options.maximize) {
    mainWindow.maximize();
    options.maximize = undefined;
    fs.writeFileSync(path.join(__dirname, '..', 'nativefier.json'), JSON.stringify(options));
  }

  const withFocusedWindow = (block) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) { block(focusedWindow); }
  };

  const adjustWindowZoom = (window, adjustment) => {
    window.webContents.getZoomFactor((zoomFactor) => {
      window.webContents.setZoomFactor(zoomFactor + adjustment);
    });
  };

  const onZoomIn = () => {
    withFocusedWindow(focusedWindow => adjustWindowZoom(focusedWindow, ZOOM_INTERVAL));
  };

  const onZoomOut = () => {
    withFocusedWindow(focusedWindow => adjustWindowZoom(focusedWindow, -ZOOM_INTERVAL));
  };

  const onZoomReset = () => {
    withFocusedWindow((focusedWindow) => {
      focusedWindow.webContents.setZoomFactor(options.zoom);
    });
  };

  const clearAppData = () => {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Yes', 'Cancel'],
      defaultId: 1,
      title: 'Clear cache confirmation',
      message: 'This will clear all data (cookies, local storage etc) from this app. Are you sure you wish to proceed?',
    }, (response) => {
      if (response !== 0) {
        return;
      }
      const { session } = mainWindow.webContents;
      session.clearStorageData(() => {
        session.clearCache(() => {
          mainWindow.loadURL(options.targetUrl);
        });
      });
    });
  };

  const onGoBack = () => {
    withFocusedWindow((focusedWindow) => {
      focusedWindow.webContents.goBack();
    });
  };

  const onGoForward = () => {
    withFocusedWindow((focusedWindow) => {
      focusedWindow.webContents.goForward();
    });
  };

  const getCurrentUrl = () => {
    withFocusedWindow((focusedWindow) => {
      focusedWindow.webContents.getURL();
    });
  };

  let createNewWindow;

  const createNewTab = (url, foreground) => {
    withFocusedWindow((focusedWindow) => {
      const newTab = createNewWindow(url);
      focusedWindow.addTabbedWindow(newTab);
      if (!foreground) {
        focusedWindow.focus();
      }
      return newTab;
    });
    return undefined;
  };

  const onNewWindow = (event, urlToGo, _, disposition) => {
    event.preventDefault();
    if (nativeTabsSupported()) {
      if (disposition === 'background-tab') {
        createNewTab(urlToGo, false);
        return;
      } else if (disposition === 'foreground-tab') {
        createNewTab(urlToGo, true);
        return;
      }
    }
    if (!linkIsInternal(options.targetUrl, urlToGo, options.internalUrls)) {
      shell.openExternal(urlToGo);
      return;
    }
    // eslint-disable-next-line no-param-reassign
    event.guest = createNewWindow(urlToGo);
  };

  const sendParamsOnDidFinishLoad = (window) => {
    window.webContents.on('did-finish-load', () => {
      window.webContents.send('params', JSON.stringify(options));
    });
  };

  createNewWindow = (url) => {
    const window = new BrowserWindow(DEFAULT_WINDOW_OPTIONS);
    if (options.userAgent) {
      window.webContents.setUserAgent(options.userAgent);
    }
    maybeInjectCss(window);
    sendParamsOnDidFinishLoad(window);
    window.webContents.on('new-window', onNewWindow);
    window.loadURL(url);
    return window;
  };

  const menuOptions = {
    nativefierVersion: options.nativefierVersion,
    appQuit: onAppQuit,
    zoomIn: onZoomIn,
    zoomOut: onZoomOut,
    zoomReset: onZoomReset,
    zoomBuildTimeValue: options.zoom,
    goBack: onGoBack,
    goForward: onGoForward,
    getCurrentUrl,
    clearAppData,
    disableDevTools: options.disableDevTools,
  };

  createMenu(menuOptions);
  if (!options.disableContextMenu) {
    initContextMenu(createNewWindow, nativeTabsSupported() ? createNewTab : undefined);
  }

  if (options.userAgent) {
    mainWindow.webContents.setUserAgent(options.userAgent);
  }

  maybeInjectCss(mainWindow);
  sendParamsOnDidFinishLoad(mainWindow);

  if (options.counter) {
    mainWindow.on('page-title-updated', (e, title) => {
      const itemCountRegex = /[([{](\d*?)\+?[}\])]/;
      const match = itemCountRegex.exec(title);
      if (match) {
        setDockBadge(match[1], options.bounce);
      } else {
        setDockBadge('');
      }
    });
  } else {
    ipcMain.on('notification', () => {
      if (!isOSX() || mainWindow.isFocused()) {
        return;
      }
      setDockBadge('•', options.bounce);
    });
    mainWindow.on('focus', () => {
      setDockBadge('');
    });
  }

  mainWindow.webContents.on('new-window', onNewWindow);

  mainWindow.loadURL(options.targetUrl);

  mainWindow.on('new-tab', () => createNewTab(options.targetUrl, true));

  mainWindow.on('close', (event) => {
    if (mainWindow.isFullScreen()) {
      if (nativeTabsSupported()) {
        mainWindow.moveTabToNewWindow();
      }
      mainWindow.setFullScreen(false);
      mainWindow.once('leave-full-screen', maybeHideWindow.bind(this, mainWindow, event, options.fastQuit));
    }
    maybeHideWindow(mainWindow, event, options.fastQuit, options.tray);
  });

  return mainWindow;
}

export default createMainWindow;
