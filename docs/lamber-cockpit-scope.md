# Lamber Cockpit: local module scope

The installed scope follows the existing household configuration: overview,
calendar, tasks, notes, contacts, birthdays, documents, and the complete kitchen
(meals, recipes, shopping and pantry). The MCP endpoint and its existing token
authentication remain available. External API token administration is removed.

Retired module entry points: rewards, schedule, inventory, housekeeping, waste,
health and budget, including their dedicated feeds and periodic jobs. SMTP,
wall displays, screensaver/photos, weather, app backup/restore and extension
installation are removed from the active application. The modules discovery
endpoint returns an empty list for compatibility.

Documents use Google Drive for all new uploads and the normal listing. Uploads
require a connected account and a configured source folder. There is no local
fallback. Synchronization retains metadata and access restrictions; missing
remote files become unavailable. Application deletion and cleanup do not delete
Drive files. Existing local document rows and bytes remain preserved, outside
the normal Drive listing. OAuth and live Drive acceptance still require a real
connection.

Historical database tables, shipped migrations, persisted settings, existing
backups and legacy document readers remain for data compatibility. Shared
authorization and migration infrastructure is retained. Some unreachable
feature services and historical descriptions still require further cleanup;
the source tree is not yet a completely stripped distribution.

Focused verification includes Drive storage/sync, MCP, disabled SMTP, admin
password recovery, active dashboard selection/pantry, schema mirror,
append-only migrations, and retained frontend imports/rendering. Existing mixed
test suites still contain expectations for retired features. Full npm test and
real browser/mobile/theme acceptance are not yet complete.

Local startup continues through ../familienplaner-deployment/start-local.ps1
using the existing familienplaner-local_yuvomi-data volume. Tests use isolated
databases and must never mount that volume.
