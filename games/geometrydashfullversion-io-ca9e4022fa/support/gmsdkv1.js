(function () {
  const globalTarget = typeof globalThis !== "undefined" ? globalThis : window;
  const sharedConfig =
    window.GMSOFT_OPTIONS && typeof window.GMSOFT_OPTIONS === "object"
      ? window.GMSOFT_OPTIONS
      : window.config && typeof window.config === "object"
        ? window.config
        : {};
  window.config = sharedConfig;
  globalTarget.config = sharedConfig;
  window.GMSOFT_OPTIONS = sharedConfig;
  globalTarget.GMSOFT_OPTIONS = sharedConfig;
  window.GMSOFT_SIGNED = window.GMSOFT_SIGNED || "local";
  window.GMSOFT_GAME_INFO = window.GMSOFT_GAME_INFO || {
    sdktype: "disabled",
    more_games_url: "",
    promotion: {},
  };
  window.GMSOFT_ADS_INFO = window.GMSOFT_ADS_INFO || {
    enable: "no",
    sdk_type: "disabled",
    time_show_inter: 999999,
    time_show_reward: 999999,
    pubid: "",
    reward: false,
    enable_reward: "no",
    enable_interstitial: "no",
    enable_preroll: "no",
  };
  if (typeof window.adConfig !== "function") {
    window.adConfig = function (options) {
      if (options && typeof options.onReady === "function") {
        options.onReady();
      }
    };
  }
  if (!Array.isArray(window.adsbygoogle)) {
    window.adsbygoogle = [];
  }
  if (!window.LocalAds || typeof window.LocalAds !== "object") {
    window.LocalAds = {
      fetchAd: function (callback) {
        if (typeof callback === "function") {
          callback({});
        }
      },
      refetchAd: function (callback) {
        if (typeof callback === "function") {
          callback({});
        }
      },
      registerRewardCallbacks: function (callbacks) {
        if (callbacks && typeof callbacks.onReady === "function") {
          callbacks.onReady();
        }
      },
      showRewardAd: function () {},
      showAd: function () {},
      available: function () {
        return false;
      },
    };
  }
  try {
    document.dispatchEvent(new CustomEvent("gmsoftSdkReady"));
  } catch (error) {
    // Ignore startup event failures in local standalone mode.
  }
})();