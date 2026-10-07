/**
 * Build-time configuration.
 *
 * There is no build step, so this file is the one place to edit by hand.
 */

/**
 * Base URL of the sync worker, with no trailing slash.
 *
 * Leave it empty and sync is simply switched off - the app works exactly as it
 * always has, entirely on the device. Set it to your deployed Cloudflare Worker
 * (see worker/README.md) and the Sync section appears in Settings.
 *
 * Example: 'https://rosterwarden-sync.your-name.workers.dev'
 */
export const SYNC_URL = 'https://rosterm8-sync.mikey-257.workers.dev';

/**
 * Planning Center OAuth client id (public - it is in every sign-in link).
 *
 * Leave it empty and the Planning Center card says it is not set up. To turn
 * it on: register an app at https://api.planningcenteronline.com/oauth/applications
 * with this site's address as the callback URL, paste the client id here and
 * into worker/wrangler.toml, and store the secret on the worker (see
 * worker/README.md). Sign-in uses SYNC_URL's worker for the token swap.
 */
export const PCO_CLIENT_ID = '';
