# CoFoundersLab Connect Bot (Chrome extension)

Sends your connection note to US & Canada founders on CoFoundersLab's **Find a CoFounder** page,
page after page. People you've already invited or connected with are skipped.

## Install
1. Open `chrome://extensions`, turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.

## Use
1. Log in to CoFoundersLab (any page).
2. Click the extension icon, write your note, click **Start**.
3. Click **Stop** any time. The Activity log shows every send and skip.

Placeholders: `{firstName}`, `{name}`, `{location}`. The site requires the note to start with a letter or number.

## How it works
1. Opens **Find a CoFounder** (`/search`) and closes the Premium pop-up if it appears.
2. For each card with a **Connect** button:
   - Looks up the person's country through the site's own profile API (`city_details.countryCode`). Only `US` and `CA` continue.
   - Checks the person's profile page in a hidden frame. The search list always shows "Connect", so the real state is only on the profile (Connect / Request Sent / Pending / connected). Anyone without **Connect** there is skipped.
   - Clicks **Connect**, writes the note, clicks **Send**. It never clicks the pop-up's **Cancel** button, because on this site that also submits the request.
3. Clicks **Next** and repeats until the last page, the per-run limit, or the daily limit.

The bot remembers who it messaged or skipped, so later runs don't check them again (**reset history** clears this).
It stops if the site reports a limit or a Premium requirement.
