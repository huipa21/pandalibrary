# Reading apps and devices

Reading apps and devices never use your web password. Create a separate **app
password** for each one in **Settings → App passwords**. Each app password has a
kind (`opds` or `kosync`) and only works for that kind of connection.

App passwords are shown once when created. Revoke one in Settings if a device is
lost. A password reset or account change by an administrator also revokes all
app passwords; create new ones afterwards.

Replace `https://books.example.org` below with your server's address. Always
use HTTPS.

## OPDS reading apps

OPDS lets reading apps browse and download books from your library.

1. Create an app password of kind `opds`.
2. In your app, add an OPDS catalog with the URL
   `https://books.example.org/opds`.
3. Sign in with your PandaLibrary username and the app password.

## KOReader progress sync

KOReader can sync your reading position with PandaLibrary.

1. Create an app password of kind `kosync`.
2. In KOReader, open the **Progress sync** plugin and set a custom sync
   server: `https://books.example.org/kosync`.
3. Sign in with your PandaLibrary username and the app password **without the
   hyphens** shown for readability.

Do not use your web password or an OPDS app password here.

Positions are matched between KOReader and the browser reader by percentage.
PDF and CBZ positions use exact pages.
