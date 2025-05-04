const perfTracker = require('./performance-tracker');
perfTracker.step('Index initialization started');

const webshare = require('./webshare');

// Na konci súboru pridať:
perfTracker.step('Index initialization completed');
perfTracker.finish('Addon startup completed');

module.exports = webshare;