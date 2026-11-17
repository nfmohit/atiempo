# gOviedo native app plan (React Native + Expo)

From the web proof of concept to an app on your iPhone through TestFlight, then a small beta
for people from Oviedo Facebook groups, with a public release left as a later choice.

Written 17 Nov 2026. Prices and limits are what Apple, Google and Expo published at the time
of writing; check them again when you sign up.

## Where we start

What the web PoC already proves (and what the app keeps):

| Piece | Today | Keep, port or replace |
| --- | --- | --- |
| Timetable | TUA part of the Asturias consortium GTFS, built into `public/data/tua.json` (~830 KB) by `scripts/build_data.py` | Keep the script. Replace the manual refresh with an automatic one (the current extract **ends 31 Dec 2026**). |
| Routing | `public/router.js`, a RAPTOR router in plain JS, with tests | Port as-is to TypeScript. It has no browser dependencies. |
| Live times | TUA `estimaciones/<stop>` via a Cloudflare Worker relay that fails now and then | Call TUA **directly from the phone**. No CORS in a native app, and requests come from many phone IPs instead of one data centre. Keep the relay only as a fallback. |
| Stop numbers | `stop-map.json` matches TUA numbers to GTFS stops (543 of 555); users can type a missing one | Keep. Ship it with the timetable data so it can be updated without an app release. |
| Search | Google Places (New) with a browser key, or Photon/Nominatim | Google Places through its REST API with an iOS/Android-restricted key. Google's terms mean results must sit on a Google map. |
| Map | Google Maps JS or Leaflet behind `mapview.js` | `react-native-maps` with the **Google** provider on both iOS and Android (Apple Maps would break the Places terms). |
| Walking directions | Public FOSSGIS OSRM demo server | **Replace.** That server's usage policy doesn't allow app traffic. Use Google Routes API (walking), which fits since we're already on Google. |

## Target architecture

```
goviedo/                     (same repo)
  core/                      shared TypeScript: router, GTFS types, live-time parsing and re-timing
  mobile/                    Expo app (Expo Router, TypeScript)
  public/                    the web PoC, kept running and moved onto core/ later
  scripts/                   data build + stop matching (unchanged)
  .github/workflows/data.yml weekly timetable refresh (new)
```

- **Expo, managed workflow, current SDK**, TypeScript, Expo Router, EAS Build/Submit/Update.
  No Mac needed: iOS builds run on EAS's machines.
- **Development builds**, not Expo Go, because the Google map provider and custom native config
  need them.
- **Libraries:** `react-native-maps` (Google provider), `expo-location`, TanStack Query (live-time
  polling, retries, stale data), `expo-file-system` (cached timetable), MMKV or AsyncStorage
  (settings, saved places, user stop numbers), `@gorhom/bottom-sheet` (the results panel),
  `expo-localization` + i18n (Spanish first, English second), Sentry (crash reports).
- **No backend of our own.** The phone talks to TUA (live), Google (search, map, walking) and a
  static file host (timetable). This keeps cost and upkeep near zero.

### Timetable data flow

1. A GitHub Action runs weekly: downloads the consortium GTFS (Mobility Database `mdb-2827`),
   runs `build_data.py`, checks the result (line count, stop count, service dates cover at least
   the next 30 days), and publishes `tua.json`, `stop-map.json` and a small `version.json` to
   GitHub Pages.
2. The app ships with a copy of the data, so it works on first launch and offline.
3. On launch, the app checks `version.json`; if newer, it downloads in the background and swaps
   it in next time. If the data the phone has is about to run out, it says so plainly instead of
   showing wrong trips.
4. If the Action fails or the feed stops covering future dates, it opens a GitHub issue so you
   hear about it before riders do.

### Live times on the phone

- Fetch `https://www.tua.es/rest/estimaciones/<stop>` directly, every 30 s while a trip is on
  screen, only for the stops in view, paused when the app is in the background.
- **Biggest technical risk:** TUA's Imperva bot shield. Phones on mobile and home networks
  should pass, as TUA's own app does, but Imperva may still challenge clients that don't look
  like a browser. Phase 0 tests this on your phone before anything else is built. Fallbacks, in
  order: send browser-like headers and keep Imperva's cookies; a hidden WebView that makes the
  request; the existing relay.
- Always show where a time came from ("live" vs "timetable") and how old it is, as the PoC does.

### API keys

- Separate Google keys for iOS (restricted to the bundle id) and Android (package name + signing
  certificate), each limited to the APIs it uses, with daily quotas set in Google Cloud.
- Keys go in EAS environment variables, not in the repo. A key inside an app can be extracted,
  so the restrictions and quotas are what protect you, not secrecy.
- The current browser key in `public/config.json` is public on GitHub; that's fine only while it
  stays referrer-restricted.

## Phases

Time estimates assume part-time work with Claude writing most of the code and you testing on
your phone.

### Phase 0: Decisions and spikes (about 1 week)

Goal: remove the risks that could change the plan.

- [ ] You: enrol in the Apple Developer Program (see Decisions). Approval can take a day or two.
- [ ] You: create a Google Cloud billing account with a budget alert (e.g. €5).
- [ ] Spike 1, **TUA from a phone**: a tiny Expo dev build that calls `estimaciones` for a few
      stops, run on your iPhone on 4G and on Wi-Fi, a few times a day for 2–3 days. Go/no-go for
      calling TUA directly.
- [ ] Spike 2, **router on the phone**: run the ported router on a mid-range Android phone and
      your iPhone; target under 300 ms for a typical trip.
- [ ] Spike 3, **Google map + Places on native**: Google provider map on iOS with one Places
      autocomplete call, to confirm the keys, attributions and terms setup.
- [ ] Write to TUA (see Decisions) so the answer arrives in time for the beta.

### Phase 1: Feature parity app (about 3–4 weeks)

Goal: the PoC's features, native, in Spanish and English.

- [ ] Monorepo layout; move `router.js` into `core/` as TypeScript; carry over the router tests
      and add a set of "golden trips" (known A→B answers) that must keep passing.
- [ ] Data pipeline: the weekly Action, `version.json`, bundled fallback, expiry warning.
- [ ] Screens: map + bottom sheet; from/to search (Google Places, current location); results
      list with live re-timing; trip detail with walk/bus/walk legs on the map; stop sheet with
      live arrivals; stop-number entry for unmatched stops.
- [ ] Walking routes via Google Routes API, with the straight-line fallback the PoC already has.
- [ ] Settings: language, saved places (Home, Work), clear data.
- [ ] Location permission text in Spanish and English; app works (with typed search) when it's
      refused.
- [ ] Sentry crash reporting, without collecting locations.
- [ ] App icon, splash screen, name "gOviedo", bundle id (e.g. `com.nfmohit.goviedo`).

### Phase 2: Personal use on TestFlight (2–3 weeks of daily use)

Goal: you rely on it for real trips and find what's wrong.

- [ ] EAS Build → EAS Submit → TestFlight, **internal testing** (your Apple ID; up to 100
      internal testers, no Apple review).
- [ ] EAS Update for quick JS fixes without a new build.
- [ ] A simple trip log in the app (on the device only) to compare "predicted" vs "what
      happened", to tune walking speed, transfer margins and the live-bus matching.
- [ ] Fix the gaps you hit; finish the last 12 unmatched stops.
- [ ] Exit criteria: 2 weeks with no crashes, live times working on most days, no trip that
      sent you to a bus that didn't exist.

### Phase 3: Beta from Facebook groups (4–8 weeks)

Goal: 20–100 local riders, real feedback, decide about a public release.

- [ ] **TestFlight external testing** with a public link you can post in the groups. The first
      build of each version goes through Apple's Beta App Review (usually a day or so). Needs a
      beta description, feedback email and a privacy policy page.
- [ ] **Android** (recommended, see Decisions): Google Play closed testing, or an installable
      build from EAS for a few testers.
- [ ] In-app "Send feedback" (email or a simple form) and a short onboarding screen.
- [ ] Privacy policy page on GitHub Pages: location stays on the phone; searches go to Google;
      stop numbers go to TUA; crash reports go to Sentry.
- [ ] A clear "not an official TUA app" note in the app and the group posts.
- [ ] Watch Google usage weekly; add caching of place lookups if needed.

### Phase 4: Public release (optional, later)

Only if the beta goes well **and** TUA's position is clear.

- [ ] App Store and Google Play listings (Spanish + English), screenshots, privacy labels.
- [ ] EU trader status declaration in App Store Connect and Play Console (a free, non-commercial
      app can usually declare non-trader; a trader has address and phone shown publicly).
- [ ] Decide on Google cost protection: hard quotas, or a small backend that caches Places
      lookups if usage grows.
- [ ] Nice-to-haves: "leave now" notification, home-screen widget, favourite stops, accessibility
      pass (VoiceOver/TalkBack, large text).

## Decisions for you

| # | Decision | Recommendation | Why it matters |
| --- | --- | --- | --- |
| 1 | **Apple Developer Program**: individual or organisation | Individual, **99 USD/year** (Apple bills the local equivalent). Needed in Phase 0. | Required for dev builds on your iPhone and for TestFlight. Your legal name shows as the developer. An organisation needs a D-U-N-S number and a legal entity. |
| 2 | **Android as well?** | Yes, from the beta. Google Play is a **one-time 25 USD**. | Most phones in Spain are Android, so an iPhone-only beta reaches a fraction of the Facebook groups. Note: new personal Play accounts must run a closed test with 12+ testers for 14 days before a public release. |
| 3 | **Google Maps Platform billing** | Turn it on with a budget alert and per-API daily quotas. | The native map SDKs are free. Places Autocomplete, Place Details and Routes have free monthly allowances per API (several thousand calls each), then charge per call. For you plus ~100 testers it should stay at or near **€0/month**; quotas cap the worst case. A card is required. |
| 4 | **TUA permission** | Email TUA (and/or the Ayuntamiento de Oviedo's mobility office) before the Facebook beta: describe the app, ask if they object, and whether they offer an official real-time feed. | The live endpoint is unofficial. Personal use is low risk; posting to public groups and a store listing is where they might object, Imperva might block, or the endpoint might change. A yes also strengthens a public App Store review. |
| 5 | **Timetable refresh** | Automatic weekly GitHub Action + in-app download (free on GitHub). | The current data **runs out on 31 Dec 2026**. Without this, the app silently goes wrong in January. Optional: register at nap.transportes.gob.es as a second source. |
| 6 | **Expo / EAS plan** | Free plan to start. | Free covers a limited number of cloud builds per month (low-priority queue) and EAS Update for small audiences, which fits Phases 1–3. The paid plan (about 19 USD/month) only if build queues slow you down. |
| 7 | **Bundle id and name** | `com.nfmohit.goviedo`, "gOviedo". | The bundle id can't be changed after the first TestFlight upload. |
| 8 | **Open source?** | Keep the repo public; keys out of the repo. | Fine either way; public helps if you ever want TUA or local devs to trust or contribute. |
| 9 | **Crash reporting** | Sentry free tier. | Without it, beta crashes are invisible. |

## Cost summary

| Item | When | Cost |
| --- | --- | --- |
| Apple Developer Program | Phase 0 | 99 USD/year |
| Google Play developer account | Phase 3 (if Android) | 25 USD once |
| Google Maps Platform | Phase 1 onward | Likely €0 within free monthly allowances; set a budget alert |
| Expo EAS | Phase 1 onward | Free plan; optional ~19 USD/month |
| GitHub Actions + Pages (data, privacy page) | Phase 1 onward | Free |
| Sentry | Phase 1 onward | Free tier |
| Cloudflare relay (fallback only) | already running | Free |

Realistic total for Phases 0–3: **about 125 USD** in the first year, plus Google only if usage
grows well beyond a beta.

## Risks and what we do about them

| Risk | Likelihood | Plan |
| --- | --- | --- |
| Imperva blocks requests from the app | Medium | Spike 1 tests it first; WebView or relay fallback; ask TUA for an official feed. |
| TUA objects to the app | Low–medium | Ask before the public beta; be ready to ship timetable-only. |
| Consortium GTFS changes format or stops updating | Low | The weekly Action validates and opens an issue; the app warns before data expires. |
| TUA renumbers or adds stops | Medium (yearly) | `stop-map.json` ships with the data; re-run the matcher; users can enter numbers. |
| Google costs grow | Low in beta | Quotas, budget alerts, session tokens on autocomplete, cached place lookups. |
| Apple rejects the external beta or public release (e.g. "minimal functionality", or a name that looks official) | Low | Clear not-official note, real features, no TUA logo. |

## What happens next

Once you've decided on 1–4 above, the first step is Phase 0: the three spikes, starting with
calling TUA from your phone. That one decides whether the native app fixes live times, which is
a main reason for going native.
