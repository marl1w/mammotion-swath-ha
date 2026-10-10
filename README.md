# Mammotion Swath

**See your lawn the way your Mammotion mower sees it — live, in Home Assistant.**

Swath adds a **Mower** page to the Home Assistant sidebar: a live map of your lawn with the mower moving across it, the route it is following, what it has mowed, its camera, your saved jobs and what has happened today — on one screen.

> Unofficial. Swath is a companion to the [Mammotion integration](https://github.com/mikey0000/Mammotion-HA) and is not affiliated with Mammotion.

## Features

### Live lawn map

- Your real lawn boundary, the charging dock and obstacles.
- The mower's position, turned the way it is facing, updated about once a second.
- The planned route and the lanes already mowed, each of which you can show or hide.
- Pan, zoom (mouse wheel, pinch or the + and − buttons), centre on the mower with one tap, and a compass so you always know which way is north.

### Lawn the route leaves out

Swath compares the route with the lawn on the map. Any part of the lawn the route does not cover is hatched on the map and counted in m², so a job that "finished" while skipping half a garden is obvious at a glance.

### Stale-route warning

A mower that stopped mid-job resumes its old route at the next start, even if you have changed the map since. Swath tells you when that is about to happen and lets you drop the old route with one tap, so the next job is planned against your current lawn.

### Saved jobs

Every job saved in the Mammotion app, with its schedule and cutting height. Start one from the panel — by default with a freshly planned route.

### Live camera

The mower's camera, played by Home Assistant's own camera player. Only the cameras you have enabled are shown; if your browser cannot play the stream, the panel tells you why.

### Activity

What the mower did over the last 24 hours: starts, pauses, returns and errors, in plain words. Repeated errors are folded into one line, and codes missing from Mammotion's own list are explained.

### At a glance

Mowing state, battery, connection and time left, with **Pause**, **Resume** and **Return to dock** where they apply, and the time left until sunset — when camera-guided mowers head home.

### Fits Home Assistant

Built from Home Assistant's own components: it follows your theme, light or dark, and works in the Home Assistant apps. On a desktop the map fills the window; on a phone the page stacks into one scrolling column.

## Requirements

- Home Assistant 2026.1 or newer.
- The [Mammotion integration](https://github.com/mikey0000/Mammotion-HA), signed in with your Mammotion account.
- For the camera: a browser that plays H.265 video, such as Safari or the Home Assistant apps on Apple devices.

## Installation

1. In HACS, open the menu → **Custom repositories**, add `https://github.com/marl1w/mammotion-swath-ha` with the type **Integration**.
2. Install **Mammotion Swath** and restart Home Assistant.
3. Go to **Settings → Devices & services → Add integration** and choose **Mammotion Swath**.

The **Mower** page appears in the sidebar.

## Tips

- **Seeing the route.** The route is shown while a job runs. In the Mammotion integration's options, turn on **Fetch mow path** so it reaches Home Assistant.
- **Several mowers?** Pick one from the selector at the top of the page.
- **Hatched areas** are a strong hint, not a verdict: if a route arrives in parts, a gap can show before the rest of it does.
