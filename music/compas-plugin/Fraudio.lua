-- ============================================================================
-- Fraudio - Compas Player Plugin
-- Stream & sync Google Drive music & audiobooks, search YouTube Music,
-- AudioBookBay, and Podcasts.
-- ============================================================================

plugin.define({
    id = "online.butfree.fraudio",
    name = "Fraudio",
    version = "1.0.0",
    api_min = 16,
})

-- ----------------------------------------------------------------------------
-- Internationalization
-- ----------------------------------------------------------------------------
local T = {
    es = {
        ["Fraudio"] = "Fraudio",
        ["Fraudio Settings"] = "Ajustes de Fraudio",
        ["Google Drive Music"] = "Música de Google Drive",
        ["Google Drive Audiobooks"] = "Audiolibros de Google Drive",
        ["Search Fraudio"] = "Buscar en Fraudio",
        ["Active Downloads"] = "Descargas activas",
        ["Settings & Pairing"] = "Ajustes y vinculación",
        ["Pair Device"] = "Vincular dispositivo",
        ["Unpair Device"] = "Desvincular dispositivo",
        ["Server URL"] = "URL del servidor",
        ["Test Connection"] = "Probar conexión",
        ["Albums"] = "Álbumes",
        ["Artists"] = "Artistas",
        ["All Songs"] = "Todas las canciones",
        ["Sync All to SD"] = "Sincronizar todo a SD",
        ["Stream Track"] = "Transmitir pista",
        ["Download to SD"] = "Descargar a SD",
        ["Play Album"] = "Reproducir álbum",
        ["Download Album"] = "Descargar álbum",
        ["Playlists"] = "Listas de reproducción",
        ["Sync All Playlists to SD"] = "Sincronizar todas las listas a SD",
        ["Sync Playlist to SD"] = "Sincronizar lista a SD",
        ["Play Playlist"] = "Reproducir lista",
    },
    de = {
        ["Fraudio"] = "Fraudio",
        ["Fraudio Settings"] = "Fraudio-Einstellungen",
        ["Google Drive Music"] = "Google Drive Musik",
        ["Google Drive Audiobooks"] = "Google Drive Hörbücher",
        ["Search Fraudio"] = "Fraudio durchsuchen",
        ["Active Downloads"] = "Aktive Downloads",
        ["Settings & Pairing"] = "Einstellungen & Kopplung",
        ["Pair Device"] = "Gerät koppeln",
        ["Unpair Device"] = "Gerät trennen",
        ["Server URL"] = "Server-URL",
        ["Test Connection"] = "Verbindung testen",
        ["Albums"] = "Alben",
        ["Artists"] = "Künstler",
        ["All Songs"] = "Alle Titel",
        ["Sync All to SD"] = "Alles auf SD synchronisieren",
        ["Stream Track"] = "Titel streamen",
        ["Download to SD"] = "Auf SD herunterladen",
        ["Play Album"] = "Album abspielen",
        ["Download Album"] = "Album herunterladen",
        ["Playlists"] = "Wiedergabelisten",
        ["Sync All Playlists to SD"] = "Alle Wiedergabelisten auf SD synchronisieren",
        ["Sync Playlist to SD"] = "Wiedergabeliste auf SD synchronisieren",
        ["Play Playlist"] = "Wiedergabeliste abspielen",
    }
}

local function tr(text)
    if plugin.tr then
        return plugin.tr(text, T)
    end
    return text
end

-- ----------------------------------------------------------------------------
-- Progress UI helpers (Plugin API 16)
-- ----------------------------------------------------------------------------
-- Modeless progress cards keep navigation and playback available while a
-- download runs. Check the capabilities for older firmware and degrade to
-- toasts when the card cannot be shown.
local has_progress_ui = plugin.has_capability and plugin.has_capability("ui.progress") or false
local has_download_progress = plugin.has_capability and plugin.has_capability("network.http.download_progress") or false

local function format_bytes(n)
    n = tonumber(n) or 0
    if n >= 1024 * 1024 then
        return string.format("%.1f MB", n / (1024 * 1024))
    elseif n >= 1024 then
        return string.format("%.0f KB", n / 1024)
    end
    return string.format("%d B", math.floor(n))
end

local function show_progress_card(title, message, fraction)
    if not has_progress_ui then return nil end
    local ok, handle = pcall(plugin.show_progress, title, message, fraction)
    if ok and handle then return handle end
    return nil
end

local function update_progress_card(handle, message, fraction)
    if not handle or not has_progress_ui then return false end
    local ok, visible = pcall(plugin.update_progress, handle, message, fraction)
    return ok and visible == true
end

local function close_progress_card(handle)
    if not handle or not has_progress_ui then return end
    pcall(plugin.close_progress, handle)
end

-- ----------------------------------------------------------------------------
-- Constants & State
-- ----------------------------------------------------------------------------
local DEFAULT_SERVER = "https://music.butfree.online"
local pair_poll_timer = nil
local active_pair_code = nil
local active_downloads = {} -- list of { id, title, progress, status, dest }
local active_jobs = {}      -- list of { jobId, title, status, percent, phase }

-- In-memory cache for Drive library
local drive_cache = {
    tracks = nil,
    audiobooks = nil,
    albums = nil,
    artists = nil,
    playlists = nil,
    last_fetched = 0
}

-- ----------------------------------------------------------------------------
-- Forward Declarations
-- ----------------------------------------------------------------------------
local open_fraudio_main
local open_fraudio_settings
local open_pairing_flow
local show_pairing_code_screen
local cancel_pairing
local open_drive_music_menu
local open_drive_playlists
local open_drive_albums
local open_drive_artists
local open_drive_all_songs
local open_drive_audiobooks_menu
local open_album_detail
local open_playlist_detail
local stream_drive_track
local queue_drive_tracks
local download_drive_track_to_sd
local download_drive_audiobook_to_sd
local sync_drive_playlist_to_sd
local sync_all_drive_playlists_to_sd
local open_search_menu
local open_search_prompt
local search_music_results
local search_audiobook_results
local search_podcast_results
local track_server_job
local open_active_downloads

-- ----------------------------------------------------------------------------
-- Helpers: Storage & Configuration
-- ----------------------------------------------------------------------------
local function get_server_url()
    local url = plugin.storage.get("server_url", DEFAULT_SERVER)
    if not url or url == "" then url = DEFAULT_SERVER end
    while #url > 0 and url:sub(-1) == "/" do
        url = url:sub(1, -2)
    end
    return url
end

local function set_server_url(url)
    if not url or url == "" then url = DEFAULT_SERVER end
    while #url > 0 and url:sub(-1) == "/" do
        url = url:sub(1, -2)
    end
    plugin.storage.set("server_url", url)
end

local function get_device_token()
    return plugin.secrets.get("device_token") or ""
end

local function set_device_token(token)
    if token and #token > 0 then
        plugin.secrets.set("device_token", token)
    else
        plugin.secrets.delete("device_token")
    end
end

local function get_device_email()
    return plugin.storage.get("device_email", "")
end

local function set_device_email(email)
    if email and #email > 0 then
        plugin.storage.set("device_email", email)
    else
        plugin.storage.delete("device_email")
    end
end

local function is_paired()
    local tok = get_device_token()
    return tok ~= nil and #tok > 0
end

local function unpair()
    set_device_token(nil)
    set_device_email(nil)
    drive_cache.tracks = nil
    drive_cache.audiobooks = nil
    drive_cache.albums = nil
    drive_cache.artists = nil
    drive_cache.playlists = nil
    drive_cache.last_fetched = 0
end

-- ----------------------------------------------------------------------------
-- Helpers: String, Path & URL
-- ----------------------------------------------------------------------------
local function url_encode(str)
    if not str then return "" end
    return (str:gsub("([^%w%-%_%.%~])", function(c)
        return string.format("%%%02X", string.byte(c))
    end))
end

local function sanitize_filename(name)
    if not name or name == "" then return "file" end
    -- replace invalid filesystem characters: / \ : * ? " < > |
    local clean = name:gsub('[/\\:*?"<>|]', "_")
    clean = clean:gsub("[%c]", "") -- remove control chars
    clean = clean:gsub("^%s+", ""):gsub("%s+$", "")
    if clean == "" then return "file" end
    return clean
end

-- YouTube Music credits all collaborators in one string ("Cal Scruby, Artist 2").
-- The SD card tree is keyed on the primary artist only, in step with the server.
local function primary_artist(name)
    if not name then return "" end
    local s = tostring(name)
    s = s:gsub("%s*[,;]%s*.*$", "")
    s = s:gsub("%s+[Ff][Ee][Aa][Tt][Uu][Rr][Ii][Nn][Gg]%s+.*$", "")
    s = s:gsub("%s+[Ff][Ee][Aa][Tt]%.?%s+.*$", "")
    s = s:gsub("%s+[Ff][Tt]%.?%s+.*$", "")
    s = s:gsub("%s+[Ww][Ii][Tt][Hh]%s+.*$", "")
    s = s:gsub("%s*&%s*.*$", "")
    s = s:gsub("%s+[Xx]%s+.*$", "")
    s = s:gsub("^%s+", ""):gsub("%s+$", "")
    return s
end

local function folder_artist(name)
    local artist = primary_artist(name)
    if artist == "" then artist = "Unknown Artist" end
    return sanitize_filename(artist)
end

local function ensure_parent_dirs(full_path)
    if not full_path then return end
    local parts = {}
    for part in full_path:gmatch("[^/]+") do
        table.insert(parts, part)
    end
    if #parts <= 1 then return end

    local current = "/" .. parts[1]
    for i = 2, #parts - 1 do
        current = current .. "/" .. parts[i]
        plugin.mkdir(current)
    end
end

-- ----------------------------------------------------------------------------
-- Network API Client
-- ----------------------------------------------------------------------------
local function api_request(method, endpoint, query_params, body_data, callback, auth_required)
    local token = get_device_token()
    if auth_required and (not token or #token == 0) then
        callback(false, nil, tr("Device not paired. Go to Settings to pair."))
        return
    end

    local base = get_server_url()
    local url = base .. endpoint

    -- Append query params
    if query_params then
        local q_parts = {}
        for k, v in pairs(query_params) do
            if v ~= nil then
                table.insert(q_parts, url_encode(k) .. "=" .. url_encode(tostring(v)))
            end
        end
        if #q_parts > 0 then
            url = url .. (endpoint:find("%?") and "&" or "?") .. table.concat(q_parts, "&")
        end
    end

    local headers = {
        ["User-Agent"] = "Fraudio-Compas/1.0",
        ["Accept"] = "application/json"
    }
    if token and #token > 0 then
        headers["Authorization"] = "Bearer " .. token
    end

    local opts = {
        url = url,
        method = method or "GET",
        headers = headers,
        timeout_seconds = 20,
        verify_tls = true
    }

    if body_data and (method == "POST" or method == "PUT") then
        local encoded, err = plugin.json_encode(body_data)
        if not encoded then
            callback(false, nil, "JSON encode error: " .. tostring(err))
            return
        end
        opts.body = encoded
        opts.headers["Content-Type"] = "application/json"
    end

    local handle, req_err = plugin.http_request(opts, function(status, body, err, resp_headers)
        if err then
            callback(false, nil, tr("Network error: ") .. tostring(err))
            return
        end

        if status == 401 then
            callback(false, nil, tr("Session expired or unauthorized. Please re-pair."))
            return
        end

        if status < 200 or status >= 300 then
            callback(false, nil, string.format(tr("HTTP error %d"), status))
            return
        end

        if not body or #body == 0 then
            callback(true, {}, nil)
            return
        end

        local data, json_err = plugin.json_decode(body)
        if not data then
            callback(false, nil, tr("JSON decode error: ") .. tostring(json_err))
            return
        end

        callback(true, data, nil)
    end)

    if not handle then
        callback(false, nil, tr("Failed to start HTTP request: ") .. tostring(req_err))
    end
end

-- ----------------------------------------------------------------------------
-- Fraudio API Specific Methods
-- ----------------------------------------------------------------------------
local function api_ping(callback)
    api_request("GET", "/api/device/ping", nil, nil, function(ok, data, err)
        if ok and data and data.ok then
            callback(true, data.version or "ok")
        else
            callback(false, err or tr("Server unavailable"))
        end
    end, false)
end

local function api_pair_request_code(callback)
    api_request("GET", "/api/device/pair/code", nil, nil, function(ok, data, err)
        if ok and data and data.ok and data.code then
            callback(true, data.code, data.pairUrl or (get_server_url() .. "/device"))
        else
            callback(false, nil, err or tr("Could not generate pairing code"))
        end
    end, false)
end

local function api_pair_poll_status(code, callback)
    api_request("GET", "/api/device/pair/status/" .. url_encode(code), nil, nil, function(ok, data, err)
        if ok and data then
            if data.status == "complete" or data.status == "confirmed" then
                local user_email = (data.user and data.user.email) or ""
                callback("complete", data.token, user_email)
            elseif data.status == "pending" then
                callback("pending", nil, nil)
            else
                callback("expired", nil, nil)
            end
        else
            callback("error", nil, err)
        end
    end, false)
end

local function api_drive_status(callback)
    local token = get_device_token()
    api_request("GET", "/api/device/drive/status", { token = token }, nil, function(ok, data, err)
        if ok and data and data.ok then
            callback(true, data)
        else
            callback(false, nil, err or tr("Could not fetch Drive status"))
        end
    end, true)
end

local function api_drive_library(kind, callback)
    local token = get_device_token()
    local params = {
        limit = 5000,
        token = token
    }
    if kind then params.kind = kind end

    api_request("GET", "/api/device/drive/library", params, nil, function(ok, data, err)
        if ok and data and data.ok then
            callback(true, data)
        else
            callback(false, nil, err or tr("Could not load Drive library"))
        end
    end, true)
end

local function api_drive_playlist_detail(playlist_id, callback)
    local token = get_device_token()
    api_request("GET", "/api/device/drive/playlists/" .. url_encode(playlist_id), { token = token }, nil, function(ok, data, err)
        if ok and data and data.ok then
            callback(true, data.playlist, data.tracks or {})
        else
            callback(false, nil, nil, err or tr("Could not load playlist tracks"))
        end
    end, true)
end

local function api_search(query, kind, callback)
    local params = {
        q = query,
        kind = kind or "music"
    }
    api_request("GET", "/api/device/search", params, nil, function(ok, data, err)
        if ok and data and data.ok then
            callback(true, data)
        else
            callback(false, nil, err or tr("Search request failed"))
        end
    end, false)
end

local function api_album_tracks(playlist_id, callback)
    api_request("GET", "/api/device/album", { playlistId = playlist_id }, nil, function(ok, data, err)
        if ok and data and data.ok then
            callback(true, data.tracks or {})
        else
            callback(false, nil, err or tr("Could not load album tracks"))
        end
    end, false)
end

local function api_artist_browse(channel_id, callback)
    api_request("GET", "/api/device/artist", { channelId = channel_id }, nil, function(ok, data, err)
        if ok and data and data.ok then
            callback(true, data)
        else
            callback(false, nil, err or tr("Could not load artist details"))
        end
    end, false)
end

local function api_podcast_episodes(feed_url, callback)
    api_request("GET", "/api/device/podcast", { feedUrl = feed_url }, nil, function(ok, data, err)
        if ok and data and data.ok then
            callback(true, data.episodes or {}, data.show or "Podcast")
        else
            callback(false, nil, err or tr("Could not load podcast episodes"))
        end
    end, false)
end

local function api_start_download_job(payload, callback)
    api_request("POST", "/api/device/download", nil, payload, function(ok, data, err)
        if ok and data and data.ok and data.jobId then
            callback(true, data.jobId, data.phase or "queued")
        else
            callback(false, nil, err or tr("Failed to start download job"))
        end
    end, false)
end

local function api_poll_job(job_id, callback)
    api_request("GET", "/api/device/jobs/" .. url_encode(job_id), nil, nil, function(ok, data, err)
        if ok and data and data.ok then
            callback(true, data)
        else
            callback(false, nil, err or tr("Job poll failed"))
        end
    end, false)
end

-- ----------------------------------------------------------------------------
-- Playback & Streaming Bridge
-- ----------------------------------------------------------------------------
local function stream_drive_track(track)
    local token = get_device_token()
    local stream_url = string.format("%s/api/device/drive/file/%s?token=%s",
        get_server_url(), url_encode(track.id), url_encode(token))

    local ok, err = pcall(plugin.play_remote, {
        provider = "fraudio",
        track_id = tostring(track.id),
        stream_url = stream_url,
        title = track.title or tr("Unknown Track"),
        artist = track.artist or tr("Unknown Artist"),
        album = track.album or tr("Unknown Album"),
        codec = "mp3",
        verify_tls = true
    })

    if not ok then
        -- Fallback to standard stream URL if remote track unsupported
        pcall(plugin.play_file, stream_url)
    end
    plugin.show_toast(string.format(tr("Playing: %s"), track.title or "Track"))
end

local function queue_drive_tracks(tracks, start_index)
    local token = get_device_token()
    local base = get_server_url()
    local remote_queue = {}
    local max_items = math.min(#tracks, 500)

    for i = 1, max_items do
        local t = tracks[i]
        local s_url = string.format("%s/api/device/drive/file/%s?token=%s",
            base, url_encode(t.id), url_encode(token))
        table.insert(remote_queue, {
            provider = "fraudio",
            track_id = tostring(t.id),
            stream_url = s_url,
            title = t.title or tr("Unknown Track"),
            artist = t.artist or tr("Unknown Artist"),
            album = t.album or tr("Unknown Album"),
            codec = "mp3",
            verify_tls = true
        })
    end

    local ok, err = pcall(plugin.queue_remote_list, remote_queue, start_index or 1)
    if not ok then
        -- Fallback to play_list with raw URLs
        local urls = {}
        for _, rq in ipairs(remote_queue) do
            table.insert(urls, rq.stream_url)
        end
        pcall(plugin.play_list, urls, start_index or 1)
    end
    plugin.show_toast(string.format(tr("Queued %d tracks"), #remote_queue))
end

-- ----------------------------------------------------------------------------
-- SD Card Downloads & Sync
-- ----------------------------------------------------------------------------
local function download_drive_track_to_sd(track, on_finish)
    local token = get_device_token()
    local sd = plugin.sd_root()
    if not sd then
        plugin.show_toast(tr("SD card not available"))
        return
    end

    local artist = folder_artist(track.artist)
    local album = sanitize_filename(track.album or "Unknown Album")
    local filename = sanitize_filename(track.filename or ((track.title or "track") .. ".mp3"))
    if not filename:lower():match("%.%w+$") then
        filename = filename .. ".mp3"
    end

    local dest_dir = string.format("%s/Music/FRAUDIO/%s/%s", sd, artist, album)
    local dest_path = dest_dir .. "/" .. filename

    ensure_parent_dirs(dest_path)

    local dl_url = string.format("%s/api/device/drive/file/%s?token=%s",
        get_server_url(), url_encode(track.id), url_encode(token))

    local dl_entry = {
        id = track.id,
        title = track.title or filename,
        progress = 0,
        status = "downloading",
        dest = dest_path
    }
    table.insert(active_downloads, dl_entry)

    plugin.show_toast(string.format(tr("Downloading: %s"), dl_entry.title))

    plugin.download_file_async(dl_url, dest_path, true, function(saved_path, err)
        dl_entry.status = saved_path and "done" or "error"
        dl_entry.progress = saved_path and 100 or 0
        if saved_path then
            plugin.show_toast(string.format(tr("Saved: %s"), dl_entry.title))
        else
            plugin.show_toast(string.format(tr("Download failed: %s"), tostring(err or "error")))
        end
        if on_finish then on_finish(saved_path ~= nil) end
    end)
end

local function download_drive_audiobook_to_sd(book, on_finish)
    local token = get_device_token()
    local sd = plugin.sd_root()
    if not sd then
        plugin.show_toast(tr("SD card not available"))
        return
    end

    local author = sanitize_filename(book.author or "Unknown Author")
    local filename = sanitize_filename(book.filename or ((book.title or "audiobook") .. ".m4b"))
    if not filename:lower():match("%.%w+$") then
        filename = filename .. ".m4b"
    end

    local dest_dir = string.format("%s/Audiobooks/FRAUDIO/%s", sd, author)
    local dest_path = dest_dir .. "/" .. filename

    ensure_parent_dirs(dest_path)

    local dl_url = string.format("%s/api/device/drive/file/%s?token=%s",
        get_server_url(), url_encode(book.id), url_encode(token))

    local dl_entry = {
        id = book.id,
        title = book.title or filename,
        progress = 0,
        status = "downloading",
        dest = dest_path
    }
    table.insert(active_downloads, dl_entry)

    plugin.show_toast(string.format(tr("Downloading: %s"), dl_entry.title))

    plugin.download_file_async(dl_url, dest_path, true, function(saved_path, err)
        dl_entry.status = saved_path and "done" or "error"
        dl_entry.progress = saved_path and 100 or 0
        if saved_path then
            plugin.show_toast(string.format(tr("Saved: %s"), dl_entry.title))
        else
            plugin.show_toast(string.format(tr("Download failed: %s"), tostring(err or "error")))
        end
        if on_finish then on_finish(saved_path ~= nil) end
    end)
end

-- ----------------------------------------------------------------------------
-- UI: Pairing Flow Screen
-- ----------------------------------------------------------------------------
local function cancel_pairing()
    if pair_poll_timer then
        plugin.clear_interval(pair_poll_timer)
        pair_poll_timer = nil
    end
    active_pair_code = nil
end

local function show_pairing_code_screen(code, pair_url)
    local function poll_tick()
        if not active_pair_code then return end
        api_pair_poll_status(active_pair_code, function(status, token, email)
            if status == "complete" and token then
                cancel_pairing()
                set_device_token(token)
                set_device_email(email or "User")
                plugin.show_toast(string.format(tr("Paired with %s!"), email or "Google Drive"))
                open_fraudio_main()
            elseif status == "expired" then
                cancel_pairing()
                plugin.show_toast(tr("Pairing code expired. Tap to get a new code."))
                open_pairing_flow()
            end
        end)
    end

    -- Cancel any previous pairing attempt first: cancel_pairing() clears
    -- active_pair_code, so the code must be assigned afterwards. Otherwise
    -- every poll_tick returns early and the screen waits forever.
    cancel_pairing()
    active_pair_code = code
    pair_poll_timer = plugin.set_interval(2, poll_tick)

    local items = {
        string.format(tr("🔑 Pairing Code:  %s"), code),
        tr("1. Open on phone/computer:"),
        pair_url or (get_server_url() .. "/device"),
        tr("2. Sign in with Google"),
        string.format(tr("3. Enter code %s"), code),
        tr("⏳ Waiting for confirmation..."),
        tr("❌ Cancel Pairing")
    }

    plugin.show_list(tr("Connect Device"), items, function(index)
        if index == 7 then
            cancel_pairing()
            plugin.show_toast(tr("Pairing cancelled"))
            open_fraudio_main()
        end
    end)
end

local function open_pairing_flow()
    plugin.show_toast(tr("Requesting pairing code..."))
    api_pair_request_code(function(ok, code, pair_url)
        if ok and code then
            show_pairing_code_screen(code, pair_url)
        else
            plugin.show_toast(tr("Could not connect to Fraudio server"))
        end
    end)
end

-- ----------------------------------------------------------------------------
-- UI: Google Drive Library Screens
-- ----------------------------------------------------------------------------
local function ensure_drive_cache(callback)
    if drive_cache.tracks and drive_cache.audiobooks then
        callback(true)
        return
    end

    plugin.show_toast(tr("Loading Google Drive library..."))
    api_drive_library(nil, function(ok, data, err)
        if not ok or not data then
            plugin.show_toast(err or tr("Failed to load Drive library"))
            callback(false)
            return
        end

        drive_cache.tracks = data.tracks or {}
        drive_cache.audiobooks = data.audiobooks or {}
        drive_cache.playlists = data.playlists or {}
        drive_cache.last_fetched = os.time()

        -- Group tracks into albums
        local albums_map = {}
        local artists_map = {}

        for _, t in ipairs(drive_cache.tracks) do
            local album_name = t.album or "Unknown Album"
            local artist_name = t.artist or "Unknown Artist"

            local alb_key = artist_name .. " - " .. album_name
            if not albums_map[alb_key] then
                albums_map[alb_key] = {
                    title = album_name,
                    artist = artist_name,
                    tracks = {}
                }
            end
            table.insert(albums_map[alb_key].tracks, t)

            if not artists_map[artist_name] then
                artists_map[artist_name] = {
                    name = artist_name,
                    tracks = {}
                }
            end
            table.insert(artists_map[artist_name].tracks, t)
        end

        local albums_list = {}
        for _, alb in pairs(albums_map) do
            table.insert(albums_list, alb)
        end
        table.sort(albums_list, function(a, b) return a.title < b.title end)
        drive_cache.albums = albums_list

        local artists_list = {}
        for _, art in pairs(artists_map) do
            table.insert(artists_list, art)
        end
        table.sort(artists_list, function(a, b) return a.name < b.name end)
        drive_cache.artists = artists_list

        callback(true)
    end)
end

local function open_album_detail(album)
    local items = {
        string.format(tr("▶️ Play Album (%d tracks)"), #album.tracks),
        tr("⬇️ Download Entire Album to SD")
    }
    for _, t in ipairs(album.tracks) do
        table.insert(items, string.format("🎵 %s", t.title or "Track"))
    end

    plugin.show_list(album.title, items, function(index)
        if index == 1 then
            queue_drive_tracks(album.tracks, 1)
        elseif index == 2 then
            plugin.show_toast(string.format(tr("Downloading %d tracks..."), #album.tracks))
            for _, t in ipairs(album.tracks) do
                download_drive_track_to_sd(t)
            end
        else
            local track_idx = index - 2
            local track = album.tracks[track_idx]
            if track then
                local track_actions = {
                    tr("▶️ Stream Track"),
                    tr("⬇️ Download to SD"),
                    tr("▶️ Play Album From Here")
                }
                plugin.show_list(track.title, track_actions, function(act_idx)
                    if act_idx == 1 then
                        stream_drive_track(track)
                    elseif act_idx == 2 then
                        download_drive_track_to_sd(track)
                    elseif act_idx == 3 then
                        queue_drive_tracks(album.tracks, track_idx)
                    end
                end)
            end
        end
    end)
end

local function open_drive_albums()
    ensure_drive_cache(function(ok)
        if not ok then return end
        local items = {}
        for _, alb in ipairs(drive_cache.albums) do
            table.insert(items, string.format("💿 %s · %s (%d)", alb.title, alb.artist, #alb.tracks))
        end

        if #items == 0 then
            plugin.show_toast(tr("No albums found in Drive"))
            return
        end

        plugin.show_list(tr("Drive Albums"), items, function(index)
            local album = drive_cache.albums[index]
            if album then open_album_detail(album) end
        end)
    end)
end

local function open_drive_artists()
    ensure_drive_cache(function(ok)
        if not ok then return end
        local items = {}
        for _, art in ipairs(drive_cache.artists) do
            table.insert(items, string.format("👤 %s (%d tracks)", art.name, #art.tracks))
        end

        if #items == 0 then
            plugin.show_toast(tr("No artists found in Drive"))
            return
        end

        plugin.show_list(tr("Drive Artists"), items, function(index)
            local art = drive_cache.artists[index]
            if art then
                local art_items = {
                    string.format(tr("▶️ Play All Songs (%d)"), #art.tracks),
                    tr("⬇️ Download All to SD")
                }
                for _, t in ipairs(art.tracks) do
                    table.insert(art_items, string.format("🎵 %s - %s", t.album or "", t.title or ""))
                end

                plugin.show_list(art.name, art_items, function(sub_idx)
                    if sub_idx == 1 then
                        queue_drive_tracks(art.tracks, 1)
                    elseif sub_idx == 2 then
                        for _, t in ipairs(art.tracks) do
                            download_drive_track_to_sd(t)
                        end
                    else
                        local t = art.tracks[sub_idx - 2]
                        if t then stream_drive_track(t) end
                    end
                end)
            end
        end)
    end)
end

local function open_drive_all_songs()
    ensure_drive_cache(function(ok)
        if not ok then return end
        local items = {}
        local tracks = drive_cache.tracks or {}

        for _, t in ipairs(tracks) do
            table.insert(items, string.format("🎵 %s · %s", t.title or "Track", t.artist or "Artist"))
        end

        if #items == 0 then
            plugin.show_toast(tr("No tracks found in Drive"))
            return
        end

        plugin.show_list(string.format(tr("All Songs (%d)"), #tracks), items, function(index)
            local track = tracks[index]
            if track then
                local actions = {
                    tr("▶️ Stream Track"),
                    tr("⬇️ Download to SD"),
                    tr("▶️ Play From Here")
                }
                plugin.show_list(track.title, actions, function(act_idx)
                    if act_idx == 1 then
                        stream_drive_track(track)
                    elseif act_idx == 2 then
                        download_drive_track_to_sd(track)
                    elseif act_idx == 3 then
                        queue_drive_tracks(tracks, index)
                    end
                end)
            end
        end)
    end)
end

local function sync_drive_playlist_to_sd(playlist, on_finish)
    local token = get_device_token()
    local sd = plugin.sd_root()
    if not sd then
        plugin.show_toast(tr("SD card not available"))
        return
    end

    local safe_name = sanitize_filename(playlist.name or "Playlist")
    local filename = safe_name .. ".m3u8"
    local m3u_dest = string.format("%s/Music/FRAUDIO/%s", sd, filename)
    ensure_parent_dirs(m3u_dest)

    local dl_url = string.format("%s/api/device/drive/playlists/%s/m3u8?token=%s",
        get_server_url(), url_encode(playlist.id), url_encode(token))

    plugin.show_toast(string.format(tr("Syncing playlist: %s"), playlist.name or safe_name))

    -- 1. Download the .m3u8 playlist file
    plugin.download_file_async(dl_url, m3u_dest, true, function(saved_path, err)
        if not saved_path then
            plugin.show_toast(string.format(tr("Failed to save playlist: %s"), tostring(err or "error")))
            if on_finish then on_finish(false) end
            return
        end

        -- Also write a copy into <SD>/Playlists/ for players scanning dedicated playlist folders
        pcall(function()
            local playlists_dir = sd .. "/Playlists"
            plugin.mkdir(playlists_dir)
            local alt_path = playlists_dir .. "/" .. filename
            plugin.copy_file(saved_path, alt_path)
        end)

        -- 2. Fetch tracks belonging to this playlist and download any missing songs to SD
        api_drive_playlist_detail(playlist.id, function(ok, pl_meta, tracks)
            if not ok or not tracks or #tracks == 0 then
                plugin.show_toast(string.format(tr("Playlist synced: %s"), playlist.name))
                if on_finish then on_finish(true) end
                return
            end

            local queued_count = 0
            for _, t in ipairs(tracks) do
                local artist = folder_artist(t.artist)
                local album = sanitize_filename(t.album or "Unknown Album")
                local song_file = sanitize_filename(t.filename or ((t.title or "track") .. ".mp3"))
                local track_path = string.format("%s/Music/FRAUDIO/%s/%s/%s", sd, artist, album, song_file)
                if not plugin.file_exists or not plugin.file_exists(track_path) then
                    download_drive_track_to_sd(t)
                    queued_count = queued_count + 1
                end
            end

            if queued_count > 0 then
                plugin.show_toast(string.format(tr("Synced %s: downloading %d new songs"), playlist.name, queued_count))
            else
                plugin.show_toast(string.format(tr("Playlist %s synced (all songs on SD)!"), playlist.name))
            end

            if on_finish then on_finish(true) end
        end)
    end)
end

local function sync_all_drive_playlists_to_sd()
    ensure_drive_cache(function(ok)
        if not ok then return end
        local playlists = drive_cache.playlists or {}
        if #playlists == 0 then
            plugin.show_toast(tr("No playlists found in Drive"))
            return
        end

        plugin.show_confirmation(
            string.format(tr("Sync all %d playlists to SD card?"), #playlists),
            tr("Sync All Playlists"),
            function()
                plugin.show_toast(string.format(tr("Syncing %d playlists..."), #playlists))
                for _, pl in ipairs(playlists) do
                    sync_drive_playlist_to_sd(pl)
                end
            end
        )
    end)
end

local function open_playlist_detail(playlist)
    plugin.show_toast(tr("Loading playlist..."))
    api_drive_playlist_detail(playlist.id, function(ok, pl_meta, tracks)
        if not ok or not tracks then
            plugin.show_toast(tr("Could not load playlist"))
            return
        end

        local items = {
            string.format(tr("▶️ Play Playlist (%d tracks)"), #tracks),
            tr("⬇️ Sync Playlist to SD (.m3u8 + songs)")
        }

        for _, t in ipairs(tracks) do
            table.insert(items, string.format("🎵 %s · %s", t.title or "Track", t.artist or "Artist"))
        end

        plugin.show_list(playlist.name or tr("Playlist"), items, function(index)
            if index == 1 then
                if #tracks > 0 then
                    queue_drive_tracks(tracks, 1)
                else
                    plugin.show_toast(tr("Playlist is empty"))
                end
            elseif index == 2 then
                sync_drive_playlist_to_sd(playlist)
            else
                local track = tracks[index - 2]
                if track then
                    local actions = {
                        tr("▶️ Stream Track"),
                        tr("⬇️ Download to SD"),
                        tr("▶️ Play From Here")
                    }
                    plugin.show_list(track.title or "Track", actions, function(act_idx)
                        if act_idx == 1 then
                            stream_drive_track(track)
                        elseif act_idx == 2 then
                            download_drive_track_to_sd(track)
                        elseif act_idx == 3 then
                            queue_drive_tracks(tracks, index - 2)
                        end
                    end)
                end
            end
        end)
    end)
end

local function open_drive_playlists()
    ensure_drive_cache(function(ok)
        if not ok then return end
        local playlists = drive_cache.playlists or {}
        local items = {
            tr("⬇️ Sync All Playlists to SD")
        }

        for _, pl in ipairs(playlists) do
            local count_str = string.format(tr("%d songs"), pl.count or 0)
            table.insert(items, string.format("📋 %s (%s)", pl.name or "Playlist", count_str))
        end

        if #playlists == 0 then
            table.insert(items, tr("No playlists created yet. Build one in Fraudio Web!"))
        end

        plugin.show_list(string.format(tr("Playlists (%d)"), #playlists), items, function(index)
            if index == 1 then
                sync_all_drive_playlists_to_sd()
            elseif #playlists > 0 and index >= 2 then
                local playlist = playlists[index - 1]
                if playlist then
                    open_playlist_detail(playlist)
                end
            end
        end)
    end)
end

local function open_drive_music_menu()
    local items = {
        tr("📋 Playlists"),
        tr("💿 Albums"),
        tr("👤 Artists"),
        tr("🎵 All Songs"),
        tr("🔄 Refresh Drive Library"),
        tr("⬇️ Sync All Songs to SD")
    }

    plugin.show_list(tr("Google Drive Music"), items, function(index)
        if index == 1 then
            open_drive_playlists()
        elseif index == 2 then
            open_drive_albums()
        elseif index == 3 then
            open_drive_artists()
        elseif index == 4 then
            open_drive_all_songs()
        elseif index == 5 then
            drive_cache.tracks = nil
            drive_cache.audiobooks = nil
            drive_cache.playlists = nil
            ensure_drive_cache(function(ok)
                if ok then plugin.show_toast(tr("Drive library refreshed!")) end
            end)
        elseif index == 6 then
            ensure_drive_cache(function(ok)
                if ok and drive_cache.tracks then
                    local count = #drive_cache.tracks
                    plugin.show_confirmation(
                        string.format(tr("Download %d songs to SD card?"), count),
                        tr("Download All"),
                        function()
                            plugin.show_toast(string.format(tr("Starting sync of %d tracks..."), count))
                            for _, t in ipairs(drive_cache.tracks) do
                                download_drive_track_to_sd(t)
                            end
                        end
                    )
                end
            end)
        end
    end)
end

local function open_drive_audiobooks_menu()
    ensure_drive_cache(function(ok)
        if not ok then return end
        local books = drive_cache.audiobooks or {}
        local items = {}

        for _, b in ipairs(books) do
            table.insert(items, string.format("📚 %s · %s", b.title or "Book", b.author or "Author"))
        end

        if #items == 0 then
            plugin.show_toast(tr("No audiobooks found in Drive"))
            return
        end

        plugin.show_list(string.format(tr("Drive Audiobooks (%d)"), #books), items, function(index)
            local book = books[index]
            if book then
                local actions = {
                    tr("▶️ Stream Audiobook"),
                    tr("⬇️ Download to SD Card")
                }
                plugin.show_list(book.title, actions, function(act_idx)
                    if act_idx == 1 then
                        local token = get_device_token()
                        local stream_url = string.format("%s/api/device/drive/file/%s?token=%s",
                            get_server_url(), url_encode(book.id), url_encode(token))

                        pcall(plugin.play_remote, {
                            provider = "fraudio",
                            track_id = tostring(book.id),
                            stream_url = stream_url,
                            title = book.title or tr("Audiobook"),
                            artist = book.author or tr("Author"),
                            album = book.series or tr("Audiobook"),
                            codec = "mp3"
                        })
                        plugin.show_toast(string.format(tr("Streaming: %s"), book.title))
                    elseif act_idx == 2 then
                        download_drive_audiobook_to_sd(book)
                    end
                end)
            end
        end)
    end)
end

-- ----------------------------------------------------------------------------
-- UI: Search & Downloader (YouTube Music, AudioBookBay, Podcasts)
-- ----------------------------------------------------------------------------
local function search_music_results(data)
    local items = {}
    local songs = data.songs or {}
    local albums = data.albums or {}
    local artists = data.artists or {}

    -- Group into single results view
    for _, s in ipairs(songs) do
        table.insert(items, string.format("🎵 %s · %s", s.title, s.artist or ""))
    end
    for _, a in ipairs(albums) do
        table.insert(items, string.format("💿 [Album] %s · %s", a.title, a.artist or ""))
    end
    for _, ar in ipairs(artists) do
        table.insert(items, string.format("👤 [Artist] %s", ar.title or ""))
    end

    if #items == 0 then
        plugin.show_toast(tr("No music results found"))
        return
    end

    plugin.show_list(tr("Search Results"), items, function(index)
        if index <= #songs then
            local s = songs[index]
            local actions = { tr("⬇️ Download Song to SD") }
            plugin.show_list(s.title, actions, function(a_idx)
                if a_idx == 1 then
                    plugin.show_toast(tr("Queuing song download on server..."))
                    api_start_download_job({
                        type = "song",
                        id = s.id,
                        title = s.title,
                        artist = s.artist,
                        album = s.album
                    }, function(ok, job_id, phase)
                        if ok then
                            track_server_job(job_id, s.title, "Music/FRAUDIO")
                        else
                            plugin.show_toast(tr("Failed to start server download"))
                        end
                    end)
                end
            end)
        elseif index <= #songs + #albums then
            local a = albums[index - #songs]
            local alb_id = a.playlistId or a.id
            plugin.show_toast(tr("Loading album tracks..."))
            api_album_tracks(alb_id, function(ok, tracks)
                if not ok or #tracks == 0 then
                    plugin.show_toast(tr("Could not load album tracks"))
                    return
                end
                local alb_items = { tr("⬇️ Download Full Album to SD") }
                for _, t in ipairs(tracks) do
                    table.insert(alb_items, string.format("🎵 %s", t.title))
                end
                plugin.show_list(a.title, alb_items, function(sub_idx)
                    if sub_idx == 1 then
                        plugin.show_toast(tr("Queuing album download on server..."))
                        api_start_download_job({
                            type = "album",
                            playlistId = alb_id,
                            title = a.title,
                            artist = a.artist
                        }, function(job_ok, job_id)
                            if job_ok then
                                track_server_job(job_id, a.title, "Music/FRAUDIO")
                            end
                        end)
                    end
                end)
            end)
        else
            local ar = artists[index - #songs - #albums]
            api_artist_browse(ar.id, function(ok, art_data)
                if not ok or not art_data then
                    plugin.show_toast(tr("Could not load artist"))
                    return
                end
                local art_items = {}
                for _, alb in ipairs(art_data.albums or {}) do
                    table.insert(art_items, string.format("💿 %s (%s)", alb.title, alb.year or ""))
                end
                for _, sg in ipairs(art_data.topSongs or {}) do
                    table.insert(art_items, string.format("🎵 %s", sg.title))
                end
                plugin.show_list(art_data.artist or ar.title, art_items, function(sub_idx)
                    plugin.show_toast(tr("Selected artist item"))
                end)
            end)
        end
    end)
end

local function search_audiobook_results(data)
    local books = data.audiobooks or {}
    local items = {}

    for _, b in ipairs(books) do
        local narrator = (b.narrator and #b.narrator > 0) and (" [Narrated by " .. b.narrator .. "]") or ""
        table.insert(items, string.format("📚 %s · %s%s", b.title, b.author or "", narrator))
    end

    if #items == 0 then
        plugin.show_toast(tr("No audiobooks found"))
        return
    end

    plugin.show_list(tr("Audiobook Results"), items, function(index)
        local b = books[index]
        if b then
            local actions = {
                tr("⬇️ Download Audiobook to SD")
            }
            plugin.show_list(b.title, actions, function(act_idx)
                if act_idx == 1 then
                    plugin.show_toast(tr("Starting audiobook server download..."))
                    api_start_download_job({
                        type = "audiobook",
                        postUrl = b.postUrl,
                        infoHash = b.infoHash,
                        title = b.title,
                        author = b.author
                    }, function(ok, job_id)
                        if ok then
                            track_server_job(job_id, b.title, "Audiobooks/FRAUDIO")
                        else
                            plugin.show_toast(tr("Failed to start audiobook job"))
                        end
                    end)
                end
            end)
        end
    end)
end

local function search_podcast_results(data)
    local pods = data.podcasts or {}
    local items = {}

    for _, p in ipairs(pods) do
        table.insert(items, string.format("🎙️ %s · %s", p.title, p.author or ""))
    end

    if #items == 0 then
        plugin.show_toast(tr("No podcasts found"))
        return
    end

    plugin.show_list(tr("Podcast Results"), items, function(index)
        local p = pods[index]
        if p and p.feedUrl then
            plugin.show_toast(tr("Loading episodes..."))
            api_podcast_episodes(p.feedUrl, function(ok, eps, show_name)
                if not ok or #eps == 0 then
                    plugin.show_toast(tr("No episodes found"))
                    return
                end
                local ep_items = {}
                for _, ep in ipairs(eps) do
                    table.insert(ep_items, string.format("▶️ %s", ep.title))
                end
                plugin.show_list(show_name, ep_items, function(ep_idx)
                    local ep = eps[ep_idx]
                    if ep and ep.audioUrl then
                        local ep_actions = {
                            tr("▶️ Stream Episode"),
                            tr("⬇️ Download Episode to SD")
                        }
                        plugin.show_list(ep.title, ep_actions, function(ea_idx)
                            if ea_idx == 1 then
                                pcall(plugin.play_file, ep.audioUrl)
                                plugin.show_toast(string.format(tr("Playing: %s"), ep.title))
                            elseif ea_idx == 2 then
                                local sd = plugin.sd_root()
                                if sd then
                                    local show_dir = sanitize_filename(show_name)
                                    local fn = sanitize_filename(ep.title) .. ".mp3"
                                    local dest = string.format("%s/Podcasts/FRAUDIO/%s/%s", sd, show_dir, fn)
                                    ensure_parent_dirs(dest)
                                    plugin.show_toast(string.format(tr("Downloading %s..."), ep.title))
                                    plugin.download_file_async(ep.audioUrl, dest, true, function(saved, err)
                                        if saved then
                                            plugin.show_toast(string.format(tr("Saved: %s"), ep.title))
                                        else
                                            plugin.show_toast(tr("Download failed"))
                                        end
                                    end)
                                end
                            end
                        end)
                    end
                end)
            end)
        end
    end)
end

-- Transfer the files of a finished server job to the SD card one at a time.
-- Only four HTTP requests may be active at once on the player, so starting an
-- entire album of downloads in parallel would fail; a queue also gives the
-- progress card a meaningful byte count.
local function transfer_job_files(job_id, title, target_folder, files, job_entry, progress)
    local sd = plugin.sd_root()
    if not sd then
        close_progress_card(progress)
        job_entry.status = "error"
        plugin.show_toast(tr("No SD card found"))
        return
    end

    local queue = {}
    local total_bytes = 0
    for _, f in ipairs(files or {}) do
        local fn = sanitize_filename(f.filename or "track.mp3")
        local dest = string.format("%s/%s/%s", sd, target_folder, fn)
        ensure_parent_dirs(dest)
        local size = tonumber(f.size) or 0
        if size > 0 then total_bytes = total_bytes + size end
        table.insert(queue, {
            name = fn,
            url = string.format("%s/api/device/jobs/%s/file/%d",
                get_server_url(), url_encode(job_id), f.index or 0),
            dest = dest,
            size = size,
            bytes = 0
        })
    end

    if #queue == 0 then
        close_progress_card(progress)
        job_entry.status = "done"
        plugin.show_toast(tr("No files to transfer"))
        return
    end

    local done_count = 0
    local failed_count = 0
    local next_index = 1
    local current = nil
    local xfer_timer = nil

    local function refresh_progress()
        local downloaded = 0
        for _, item in ipairs(queue) do
            downloaded = downloaded + item.bytes
        end

        local message, fraction
        if total_bytes > 0 then
            fraction = math.max(0, math.min(1, downloaded / total_bytes))
            message = string.format(tr("Saving %s · %s / %s"), title,
                format_bytes(downloaded), format_bytes(total_bytes))
        else
            fraction = done_count / #queue
            message = string.format(tr("Saving %s · %d / %d files"), title, done_count, #queue)
        end

        if not update_progress_card(progress, message, fraction) then
            -- The user dismissed the card or another job replaced it; keep
            -- downloading, but stop trying to update a stale handle.
            progress = nil
        end
    end

    local function start_next()
        if next_index > #queue then
            if xfer_timer then plugin.clear_interval(xfer_timer) end
            close_progress_card(progress)
            progress = nil
            job_entry.status = (failed_count > 0) and "partial" or "done"
            job_entry.percent = 100
            if failed_count > 0 then
                plugin.show_toast(string.format(tr("Saved %d/%d files, %d failed: %s"),
                    done_count, #queue, failed_count, title))
            else
                plugin.show_toast(string.format(tr("Saved %d files to SD: %s"), done_count, title))
            end
            return
        end

        local item = queue[next_index]
        next_index = next_index + 1

        local handle = nil
        handle = plugin.download_file_async(item.url, item.dest, true, function(saved, _err)
            if current == handle then current = nil end
            if saved then
                item.bytes = (item.size > 0) and item.size or item.bytes
                done_count = done_count + 1
            else
                failed_count = failed_count + 1
                plugin.show_toast(string.format(tr("Failed to save: %s"), item.name))
            end
            refresh_progress()
            start_next()
        end)

        if not handle then
            failed_count = failed_count + 1
            plugin.show_toast(string.format(tr("Could not start download: %s"), item.name))
            refresh_progress()
            start_next()
            return
        end
        current = handle
    end

    if has_download_progress then
        xfer_timer = plugin.set_interval(1, function()
            if not current or not progress then return end
            local ok, snapshot = pcall(plugin.get_download_progress, current)
            if ok and snapshot and snapshot.downloaded then
                local item = queue[next_index - 1]
                if item then
                    item.bytes = math.max(item.bytes, tonumber(snapshot.downloaded) or 0)
                end
                refresh_progress()
            end
        end)
    end

    refresh_progress()
    start_next()
end

function track_server_job(job_id, title, target_folder)
    local job_entry = {
        jobId = job_id,
        title = title,
        status = "queued",
        percent = 0,
        phase = tr("Queued"),
        folder = target_folder
    }
    table.insert(active_jobs, job_entry)

    local progress = show_progress_card(tr("Fraudio Download"),
        string.format(tr("Queued: %s"), title), 0)
    plugin.show_toast(string.format(tr("Job queued: %s"), title))

    local timer = nil
    timer = plugin.set_interval(3, function()
        api_poll_job(job_id, function(ok, data)
            if not ok or not data then return end
            job_entry.status = data.status
            job_entry.percent = tonumber(data.percent) or 0
            job_entry.phase = data.phase or data.status

            if data.status == "error" then
                plugin.clear_interval(timer)
                timer = nil
                close_progress_card(progress)
                job_entry.status = "error"
                plugin.show_toast(string.format(tr("Download failed: %s"),
                    tostring(data.error or tr("Error"))))
                return
            end

            if data.status == "ready" then
                plugin.clear_interval(timer)
                timer = nil
                transfer_job_files(job_id, title, target_folder, data.files, job_entry, progress)
                return
            end

            -- Server-side phase: percent is the real overall job progress.
            local pct = math.max(0, math.min(1, job_entry.percent / 100))
            local message = string.format("%s · %d%%", job_entry.phase, job_entry.percent)
            if not update_progress_card(progress, message, pct) then
                progress = nil
            end
        end)
    end)
end

local function open_search_prompt(kind)
    local titles = {
        music = tr("Search Music (YouTube Music)"),
        audiobook = tr("Search Audiobooks (AudioBookBay)"),
        podcast = tr("Search Podcasts")
    }

    plugin.show_text_input(titles[kind] or tr("Search Fraudio"), "", false, function(query)
        if not query or query:gsub("%s+", "") == "" then return end
        plugin.show_toast(string.format(tr("Searching '%s'..."), query))

        api_search(query, kind, function(ok, data, err)
            if not ok or not data then
                plugin.show_toast(err or tr("Search failed"))
                return
            end

            if kind == "audiobook" then
                search_audiobook_results(data)
            elseif kind == "podcast" then
                search_podcast_results(data)
            else
                search_music_results(data)
            end
        end)
    end)
end

local function open_search_menu()
    local items = {
        tr("🎵 Search Music (YouTube Music)"),
        tr("📚 Search Audiobooks (AudioBookBay)"),
        tr("🎙️ Search Podcasts")
    }

    plugin.show_list(tr("Search Fraudio"), items, function(index)
        if index == 1 then
            open_search_prompt("music")
        elseif index == 2 then
            open_search_prompt("audiobook")
        elseif index == 3 then
            open_search_prompt("podcast")
        end
    end)
end

-- ----------------------------------------------------------------------------
-- UI: Active Downloads Screen
-- ----------------------------------------------------------------------------
local function open_active_downloads()
    local items = {}

    for _, dl in ipairs(active_downloads) do
        table.insert(items, string.format("[%s] %s (%d%%)", dl.status:upper(), dl.title, dl.progress))
    end

    for _, jb in ipairs(active_jobs) do
        table.insert(items, string.format("[SERVER %s] %s (%d%% - %s)",
            jb.status:upper(), jb.title, jb.percent, jb.phase))
    end

    if #items == 0 then
        plugin.show_toast(tr("No active downloads"))
        return
    end

    plugin.show_list(tr("Active Downloads"), items, function(index)
        plugin.show_toast(tr("Download in progress"))
    end)
end

-- ----------------------------------------------------------------------------
-- UI: Settings Screen
-- ----------------------------------------------------------------------------
function open_fraudio_settings()
    local paired = is_paired()
    local email = get_device_email()
    local s_url = get_server_url()

    local items = {
        paired and string.format(tr("👤 Account: %s"), email) or tr("⚠️ Status: Not Paired"),
        paired and tr("🔑 Re-pair / Switch Account") or tr("🔑 Pair Device"),
        paired and tr("❌ Unpair Device") or nil,
        string.format(tr("🌐 Server: %s"), s_url),
        tr("⚡ Test Server Connection"),
        tr("🔄 Clear Drive Cache"),
        tr("ℹ️ About Fraudio")
    }

    -- Filter out nils
    local clean_items = {}
    for _, it in ipairs(items) do
        if it then table.insert(clean_items, it) end
    end

    plugin.show_list(tr("Fraudio Settings"), clean_items, function(index)
        local selected = clean_items[index]
        if selected:find(tr("Pair Device")) or selected:find(tr("Re-pair")) then
            open_pairing_flow()
        elseif selected:find(tr("Unpair Device")) then
            plugin.show_confirmation(
                tr("Unpair from Google Drive?"),
                tr("Unpair"),
                function()
                    unpair()
                    plugin.show_toast(tr("Device unpaired"))
                    open_fraudio_settings()
                end
            )
        elseif selected:find(tr("Server:")) then
            plugin.show_text_input(tr("Server URL"), s_url, false, function(new_url)
                if new_url and #new_url > 0 then
                    set_server_url(new_url)
                    plugin.show_toast(tr("Server URL updated"))
                    open_fraudio_settings()
                end
            end)
        elseif selected:find(tr("Test Server Connection")) then
            plugin.show_toast(tr("Testing connection..."))
            api_ping(function(ok, msg)
                if ok then
                    plugin.show_toast(string.format(tr("Connected! Fraudio version: %s"), msg))
                else
                    plugin.show_toast(string.format(tr("Connection failed: %s"), msg))
                end
            end)
        elseif selected:find(tr("Clear Drive Cache")) then
            drive_cache.tracks = nil
            drive_cache.audiobooks = nil
            drive_cache.albums = nil
            drive_cache.artists = nil
            plugin.show_toast(tr("Drive cache cleared"))
        elseif selected:find(tr("About Fraudio")) then
            local about_text = {
                tr("Fraudio for Compás Player v1.0.0"),
                tr("Stream & Sync Google Drive Audio"),
                tr("Search YouTube Music, ABB & Podcasts"),
                string.format(tr("Server: %s"), s_url)
            }
            plugin.show_list(tr("About"), about_text, function() end)
        end
    end)
end

-- ----------------------------------------------------------------------------
-- UI: Main Fraudio Portal
-- ----------------------------------------------------------------------------
function open_fraudio_main()
    local paired = is_paired()
    local email = get_device_email()

    local items = {}
    if paired then
        table.insert(items, string.format(tr("👤 Linked to: %s"), email))
        table.insert(items, tr("🎵 Google Drive Music"))
        table.insert(items, tr("📚 Google Drive Audiobooks"))
        table.insert(items, tr("🔍 Search Fraudio"))
        if #active_downloads > 0 or #active_jobs > 0 then
            table.insert(items, string.format(tr("⬇️ Active Downloads (%d)"), #active_downloads + #active_jobs))
        end
        table.insert(items, tr("⚙️ Settings & Pairing"))
    else
        table.insert(items, tr("⚠️ Not Paired (Tap to Connect)"))
        table.insert(items, tr("🔑 Pair Device with Google Drive"))
        table.insert(items, tr("🔍 Search Fraudio"))
        if #active_downloads > 0 or #active_jobs > 0 then
            table.insert(items, string.format(tr("⬇️ Active Downloads (%d)"), #active_downloads + #active_jobs))
        end
        table.insert(items, tr("⚙️ Settings"))
    end

    plugin.show_list("Fraudio", items, function(index)
        local choice = items[index]
        if choice:find(tr("Not Paired")) or choice:find(tr("Pair Device")) then
            open_pairing_flow()
        elseif choice:find(tr("Drive Music")) then
            open_drive_music_menu()
        elseif choice:find(tr("Drive Audiobooks")) then
            open_drive_audiobooks_menu()
        elseif choice:find(tr("Search Fraudio")) then
            open_search_menu()
        elseif choice:find(tr("Active Downloads")) then
            open_active_downloads()
        elseif choice:find(tr("Settings")) or choice:find(tr("Linked to:")) then
            open_fraudio_settings()
        end
    end)
end

-- ----------------------------------------------------------------------------
-- Entry Point Registration
-- ----------------------------------------------------------------------------
plugin.register_stream_media_tile("Fraudio", open_fraudio_main, "stream_media/radio.png")
plugin.register_list_item("music", "Fraudio", open_fraudio_main)
plugin.register_list_item("settings", "Fraudio Settings", open_fraudio_settings)
