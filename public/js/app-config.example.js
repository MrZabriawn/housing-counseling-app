/**
 * app-config.example.js — template for app-config.js
 *
 * Copy this file to app-config.js and fill in real values.
 * app-config.js is gitignored. This example file is safe to commit.
 */

// Shared API key for Qrew ↔ Housing status sync and job creation
// Obtain from the Qrew project admin.
export const QREW_API_KEY = 'YOUR_QREW_API_KEY_HERE';

// Google Apps Script web app URL for sending email (survey invitations).
// Deploy apps-script-email.gs as a web app: Execute as Me, Anyone can access.
// Paste the deployment URL here.
export const EMAIL_SERVICE_URL = 'YOUR_APPS_SCRIPT_WEB_APP_URL';

// Google Chat incoming webhook URLs.
// Closure notification — fires when a client file is closed.
export const GOOGLE_CHAT_CLOSURE_WEBHOOK = 'YOUR_CLOSURE_WEBHOOK_URL';

// Survey response notification — fires when a client submits their survey.
export const GOOGLE_CHAT_SURVEY_WEBHOOK = 'YOUR_SURVEY_WEBHOOK_URL';
