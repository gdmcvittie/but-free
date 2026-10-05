# FREEVEE - Roku App

A simplified Roku channel for the FREEVEE server, designed for streaming from the cloud instance at FREEVEE.liftedpixel.ca.

## Features

- **Home Screen**: Browse popular movies and TV shows from What's On
- **Services**: Browse streaming service catalogs (Netflix, Prime, Disney, etc.)
- **Search**: Search for torrents across multiple sources
- **Free TV**: Watch live FAST channels (Pluto TV, Tubi, Roku Channel)

## Server Configuration

This app connects to:
- **Main Server**: `https://tv.butfree.online`
- **Torrent Server**: `http://download.butfree.online`

## Removed Features

This version removes the following features from roku2:
- User login/profiles system
- Local library browsing (TV Shows, Movies, Downloads)
- Library-based live TV channels
- Continue Watching (requires auth)
- Favorites (requires auth)
- Server IP configuration (hardcoded to cloud server)

## Building

Use the standard Roku development workflow:
1. Package the app using `pkg` tool or IDE
2. Install on Roku device via developer mode
3. The app will automatically connect to the cloud server
