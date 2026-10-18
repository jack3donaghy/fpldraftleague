/**
 * LEAGUE SETTINGS – the only file you normally need to edit.
 */
window.CONFIG = {
  // Paste your Cloudflare Worker address here (step 1 of the setup guide)
  API_BASE: 'https://tokyo-draft.6w95tj982g.workers.dev',

  LEAGUE_ID: 43649,       // current draft league
  OLD_LEAGUE_ID: null,    // February: set to the pre-January league ID so its points are added
  START_GW: 5,            // league scoring starts at this gameweek

  TITLE_TOP: 'FPL Draft 3',
  TITLE: 'Tokyo Draft',
  SEASON: '26/27',
  LOGO: 'fpl%20image%20logo.png', // the logo file already in this repo

  PTP_COUNT_IN_PLAY: true, // true: "to play" includes matches in progress; false: only not kicked off
  MIN_LOADER_MS: 1500,     // keep the loading screen up at least this long
  REFRESH_SECONDS: 60      // how often live data refreshes during a gameweek
};
