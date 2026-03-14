(function(){
  const noop = function(){};
  const tracker = {
    initialize: function(){ return Promise.resolve({}); },
    init: function(){ return Promise.resolve({}); },
    ready: function(){ return Promise.resolve({}); },
    track: noop,
    identify: noop,
    page: noop,
    event: noop,
    setUser: noop,
    log: noop,
  };
  window.ga = window.ga || noop;
  window.gamedock = window.gamedock || tracker;
  window.Gamedock = window.Gamedock || tracker;
  window.GameDock = window.GameDock || tracker;
})();
