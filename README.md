# Webshare Stremio Addon

This addon enables streaming movies and series from Webshare.cz.

The main principles are simplicity and low-maintenance. For this reason there is no video catalog
which would provide high-quality content. This addon works by searching files directly on
webshare.cz. Note this may and does produce incorrect results, but you can usually quickly find the
correct streams.

Feel free to open up issues if you find any issues.

## How can I use it?

Go to https://20317bf4c6c6-webshare-stremio-addon.baby-beamup.club/, enter your Webshare.cz login
details and install.

This addon is not yet submitted to the community addon catalog, that will be done after some testing
period.

## Development

Follow the usual steps:

- install dependencies - `npm install`
- create file `config/keys.js` from template `config/keys.js.sample` and fill in TMDB API key. This
  is not required but some features might require the API key to be present and working.
- install the addon in local stremio instance - `npm start -- --install`

See [Stremion Addon SDK](https://github.com/Stremio/stremio-addon-sdk) for more information.