# Featured Guides

Curated destination guides enriched with real places to explore, with one-tap add straight into your trip.

![screenshot](./docs/screenshot.png)

## What it does

Featured Guides adds a standalone **Guides** page to TREK's navigation — a
browsable library of curated destination guides, independent of any single
trip. Each guide is built from an **ordered list of content blocks**, the
same idea as a modern page editor: headings, body text, quotes, images,
links, dividers, day markers, embedded references to other guides, and rich
place/activity cards — added, edited, deleted and **drag-reordered** freely
by an admin.

Creating a guide starts with a short "Configure your guide" step: a title, a
location, and a template — **Blank** (freeform), **List** (a flat set of
places with no day structure), or **Itinerary** (pick a number of days and
that many **Day** blocks are pre-created immediately, so the guide's shape
is visible from the start). Guides start as a **Draft**, visible only to
admins, until explicitly **Published** — only published guides appear in the
browsable list for everyone else.

Typing a **Location** checks it against OpenTripMap in the background (if the
admin has their own API key set — see Setup) and shows what it resolved to, or
a warning if nothing matched. It's a nudge, not a hard rule — saving with an
unrecognized location just asks for confirmation first, since OpenTripMap
doesn't know every neighbourhood or region someone might legitimately type.

An admin builds a guide's content from an **"+ Add item"** menu offering
every block type. A **Place** block has three ways to fill it in:

- **Manually** — type in the name, description, rating and tips, and pick a
  **category** from a fixed, colour-coded list (Activity, Attraction,
  Bar/Cafe, Beach, Hotel, Nature, Other, Restaurant, Shopping, Transport) —
  the same colours show up as a badge on every place card. Places imported
  from OpenTripMap, a Collection, or a PDF get bucketed into this same list
  automatically from whatever category they arrived with.
- **Search OpenTripMap** using the admin's own API key — search resolves the
  destination to coordinates, lists nearby points of interest, and importing
  one pulls in its name, category, address, a Wikipedia-derived description,
  a popularity rating, and a thumbnail photo where OpenTripMap has one.
  Imported data (including the photo) is cached in the plugin's own database,
  so browsing a guide never triggers a live API call — only an admin's search
  and import does, against that admin's own key.
- **From one of your TREK Collections** — browse a collection you've already
  saved places into and pull any of them straight into the guide.

An **Image** block is uploaded straight from the admin's device (no external
hosting involved); the guide list's cover photo is taken from the first
place or image block that has one, falling back to a generated colour cover
otherwise.

Guide detail pages show a sticky timeline strip of pills for every **Day**
block so travellers can jump straight to a day, alongside a connecting rail
down the page.

Any traveller browsing a guide can add a **Place** or **Activity** block
straight into one of their own trips with a single click: pick the trip from
a short list and it's created in that trip's place pool, ready to be
scheduled onto a day.

A **Plan a trip** button on every guide goes further: pick a start and end
date and it creates a brand-new trip for that time frame, using the guide as
a template — every place and activity in the guide is added, and each one is
scheduled onto the matching calendar day wherever the guide's **Day** blocks
say it belongs (a place before day 1, or past the date range you picked,
still gets added — just left in the trip's place pool instead of scheduled).

Note: there is deliberately **no live map**. TREK plugins run in a sandboxed
iframe whose content-security policy blocks loading map tiles from any
external host, so a pannable/zoomable map isn't something a plugin can do —
only a non-interactive static image would be possible, and this plugin
doesn't attempt one.

**Import a guide from PDF** — built for Mindtrip-style "inspiration" exports
and similar trip-guide PDFs. An admin picks a PDF; the text is extracted
right there in the browser (a bundled PDF reader — the file itself never
leaves the iframe), then structured into a guide using the admin's own
configured AI provider. If no AI provider is available — not configured,
or this TREK instance doesn't support it — it automatically falls back to a
deterministic, no-AI text parser that recognizes the same place/category/
address pattern these exports use, so the import still works, just with a
somewhat less capable structuring pass. Either way, the result — title,
location, overview, and every place found (grouped under **Day** blocks if
the source PDF has them) — always lands as a **Draft** for review, never
auto-published.

The PDF's embedded photos are pulled out too, in the same browser-only pass —
a cover/hero photo (typically the export's intro banner) becomes the guide's
first **Image** block, and every other real photo found is matched, in the
order it appears in the document, to the places found in that same order.
It's a best-effort, positional match rather than a guaranteed one-to-one
pairing, so a photo can occasionally land on the wrong neighbouring place —
worth a quick check before publishing. If an admin has an OpenTripMap key set
(see Setup), imported places also get a best-effort pass at real coordinates:
the guide's destination is geocoded once, everything OpenTripMap knows about
nearby is pulled in one sweep, and any place whose name matches gets that
point. Anything still without coordinates after that — most hotels,
restaurants and small local spots, which OpenTripMap doesn't carry — gets a
second pass instead of being left blank: its extracted **address** is looked
up directly against OpenStreetMap's Nominatim geocoder (free, no key needed).
A guide imported before this existed (or one where some places still didn't
resolve) can be fixed retroactively — **Manage guides → open a guide** shows a
**Find missing coordinates** button whenever it has any place still lacking
one.

## Screenshots

Show it in context. Commit a `docs/screenshot.png` — it's what the store card
shows. A 16:9 image (e.g. 1600×900) with your plugin centred and some margin
looks best (the card crops the edges).

## Permissions

| Permission | Why |
|---|---|
| `db:own` | Stores every guide and its curated places — including any imported thumbnail photo — in the plugin's own database, the library that browsing reads from. |
| `http:outbound` | Marker permission required alongside the specific outbound host below. |
| `http:outbound:*.opentripmap.com` | Lets an admin's guide-editing search reach the OpenTripMap API (and its own thumbnail-image host) to look up destinations, points of interest, and photos, using that admin's own key. |
| `http:outbound:nominatim.openstreetmap.org` | Lets an imported place that OpenTripMap couldn't match get geocoded from its address instead, via OpenStreetMap's free Nominatim service — no key needed, and it's only ever used as a fallback for places OpenTripMap's own sweep already missed. |
| `db:read:trips` | Lists the signed-in user's own trips so they can pick which one to add a place into. |
| `db:write:places` | Creates the selected place inside the chosen trip's place pool when a user clicks "Add to trip" or "Plan a trip". |
| `db:read:collections` | Lets an admin browse their own saved Collections and pull a place from one straight into a guide. |
| `db:create:trips` | Lets "Plan a trip" create the new trip itself, for the time frame the user picked. |
| `db:write:days` | Lets "Plan a trip" create the day rows it needs to schedule the guide's places onto the right calendar date. |
| `db:write:itinerary` | Lets "Plan a trip" assign each imported place onto its matching day. |
| `ai:invoke` | Lets an admin's "Import from PDF" structure the extracted text into a guide, using that admin's own configured AI provider. |

## Setup

1. Install the plugin — no setup is required just to browse guides or add
   places to a trip.
2. Any admin who wants to search OpenTripMap while curating a guide should get
   a free API key at [opentripmap.io](https://opentripmap.io/product) and paste
   it into their own **OpenTripMap API key** field on this plugin's settings
   page (per-user — each admin uses their own key; manually-entered places
   never need one).
3. Open the **Guides** page from the main navigation. Admins see a
   **Manage guides** button to create guides, build their content block by
   block (places by hand, by searching OpenTripMap, or by picking from one of
   their own Collections — the last option needs the Collections addon
   enabled), **Import from PDF** a Mindtrip-style guide export (needs an AI
   provider configured on the admin's own account), and **Publish** a guide
   once it's ready; every user sees the published guide library and can add
   any place or activity into one of their own trips.

## License

MIT
