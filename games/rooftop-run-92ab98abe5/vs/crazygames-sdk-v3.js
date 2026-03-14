(function () {
  var root = window.CrazyGames = window.CrazyGames || {};
  var sdk = root.SDK = root.SDK || {};
  var ad = sdk.ad = sdk.ad || {};
  var banner = sdk.banner = sdk.banner || {};
  var data = sdk.data = sdk.data || {};
  var environment = sdk.environment = sdk.environment || {};
  var game = sdk.game = sdk.game || {};
  var user = sdk.user = sdk.user || {};
  var storageNamespace =
    typeof window.__unityStandaloneStorageNamespace === "string" &&
    window.__unityStandaloneStorageNamespace
      ? window.__unityStandaloneStorageNamespace
      : "global";
  var storagePrefix = "__unity_standalone_crazygames__:" + storageNamespace + ":";
  var legacyStoragePrefix = "__unity_standalone_crazygames__:";
  var authListeners = [];

  function resolved(value) {
    return Promise.resolve(value);
  }

  function safeCall(callback) {
    if (typeof callback !== "function") {
      return;
    }
    try {
      callback.apply(null, Array.prototype.slice.call(arguments, 1));
    } catch (_err) {}
  }

  function storageLookupKeys(key) {
    var normalized = String(key == null ? "" : key);
    var keys = [
      storagePrefix + normalized,
      legacyStoragePrefix + normalized
    ];
    if (normalized) {
      keys.push(normalized);
    }
    return keys.filter(function (value, index) {
      return keys.indexOf(value) === index;
    });
  }

  function readStorageValue(key) {
    try {
      var keys = storageLookupKeys(key);
      for (var index = 0; index < keys.length; index += 1) {
        var currentKey = keys[index];
        var value = window.localStorage.getItem(currentKey);
        if (value !== null) {
          if (currentKey !== storagePrefix + String(key == null ? "" : key)) {
            try {
              window.localStorage.setItem(storagePrefix + String(key == null ? "" : key), value);
            } catch (_migrationErr) {}
          }
          return value;
        }
      }
    } catch (_err) {
      return null;
    }
    return null;
  }

  function writeStorageValue(key, value) {
    var normalized = String(key == null ? "" : key);
    var stringValue = String(value == null ? "" : value);
    try {
      window.localStorage.setItem(storagePrefix + normalized, stringValue);
    } catch (_err) {}
    return stringValue;
  }

  function removeStorageValue(key) {
    try {
      storageLookupKeys(key).forEach(function (lookupKey) {
        window.localStorage.removeItem(lookupKey);
      });
    } catch (_err) {}
  }

  sdk.addInitCallback = function (callback) {
    safeCall(callback, {});
  };
  sdk.init = function () {
    return resolved({});
  };
  ad.hasAdblock = function (callback) {
    safeCall(callback, null, false);
    return resolved(false);
  };
  ad.requestAd = function (_adType, callbacks) {
    callbacks = callbacks || {};
    safeCall(callbacks.adStarted);
    safeCall(callbacks.adFinished);
    safeCall(callbacks.adComplete);
    safeCall(callbacks.adDismissed);
    return resolved("closed");
  };
  banner.requestOverlayBanners = function (_banners, callback) {
    safeCall(callback, "", "bannerRendered", null);
    return resolved("bannerRendered");
  };
  data.getItem = function (key) {
    return readStorageValue(key);
  };
  data.setItem = function (key, value) {
    return writeStorageValue(key, value);
  };
  data.removeItem = function (key) {
    removeStorageValue(key);
  };
  data.clear = function () {
    try {
      Object.keys(window.localStorage).forEach(function (key) {
        if (key.indexOf(storagePrefix) === 0 || key.indexOf(legacyStoragePrefix) === 0) {
          window.localStorage.removeItem(key);
        }
      });
    } catch (_err) {}
  };
  data.syncUnityGameData = function () {
    return resolved();
  };
  game.gameplayStart = function () {
    return resolved();
  };
  game.gameplayStop = function () {
    return resolved();
  };
  game.happytime = function () {
    return resolved();
  };
  game.hideInviteButton = function () {
    return resolved();
  };
  game.showInviteButton = function () {
    return resolved();
  };
  game.inviteLink = function () {
    return resolved("");
  };
  user.addAuthListener = function (callback) {
    if (typeof callback === "function") {
      authListeners.push(callback);
    }
    safeCall(callback, {});
    return function () {};
  };
  user.addScore = function () {
    return resolved();
  };
  user.getUser = function () {
    return resolved({});
  };
  user.getUserToken = function () {
    return resolved("");
  };
  user.getXsollaUserToken = function () {
    return resolved("");
  };
  user.showAccountLinkPrompt = function () {
    return resolved({});
  };
  user.showAuthPrompt = function () {
    return resolved({});
  };
  if (typeof user.systemInfo !== "object" || !user.systemInfo) {
    user.systemInfo = {
      countryCode: "",
      locale: navigator.language || "en-US",
      os: navigator.platform || "",
      browser: navigator.userAgent || "",
    };
  }
  if (typeof user.isUserAccountAvailable !== "boolean") {
    user.isUserAccountAvailable = false;
  }
  if (typeof environment !== "object" || !environment) {
    environment = sdk.environment = {};
  }
  if (typeof environment.platform !== "string") {
    environment.platform = "web";
  }
  if (typeof environment.device !== "string") {
    environment.device = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
      ? "mobile"
      : "desktop";
  }
  sdk.isQaTool = function () {
    return false;
  };

  var legacyRoot = window.Crazygames = window.Crazygames || {};
  if (typeof legacyRoot.requestInviteUrl !== "function") {
    legacyRoot.requestInviteUrl = function () {};
  }
  root.init = sdk.init;
})();
