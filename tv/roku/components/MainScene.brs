sub init()
    m.top.backgroundUri = "pkg:/images/bg.jpg"
    m.top.backgroundColor = "0x00000000"

    m.serverUrl = "https://tv.butfree.online"
    m.torrentServerUrl = "http://download.butfree.online"
    m.state = "grid"
    m.isIpFocused = false
    m.isLiveChannel = false
    m.savedGridBreadcrumb = "Home"

    m.gridScreen = m.top.findNode("gridScreen")
    m.folderBreadcrumb = m.top.findNode("folderBreadcrumb")
    m.posterGrid = m.top.findNode("posterGrid")
    m.posterGrid.observeField("itemFocused", "onPosterFocused")
    m.posterGrid.observeField("itemSelected", "onPosterSelected")

    m.cwLabel = m.top.findNode("cwLabel")
    m.cwGrid = m.top.findNode("cwGrid")
    m.cwGrid.observeField("itemFocused", "onCwFocused")
    m.cwGrid.observeField("itemSelected", "onCwSelected")
    m.cwItems = []

    m.cwInfoBar = m.top.findNode("cwInfoBar")
    m.cwInfoTitle = m.top.findNode("cwInfoTitle")
    m.cwInfoDesc = m.top.findNode("cwInfoDesc")

    m.pairingGroup = m.top.findNode("pairingGroup")
    m.pairingTitle = m.top.findNode("pairingTitle")
    m.pairingSubtitle = m.top.findNode("pairingSubtitle")
    m.pairingQr = m.top.findNode("pairingQr")
    m.pairingCodeLabel = m.top.findNode("pairingCodeLabel")
    m.pairingHint = m.top.findNode("pairingHint")

    m.detailTitle = m.top.findNode("detailTitle")
    m.detailDesc = m.top.findNode("detailDesc")

    m.heroGroup = m.top.findNode("heroGroup")
    m.homeBg = m.top.findNode("homeBg")
    m.homeOverlay = m.top.findNode("homeOverlay")
    m.heroTitle = m.top.findNode("heroTitle")
    m.heroDesc = m.top.findNode("heroDesc")

    m.ipLabel = m.top.findNode("ipLabel")
    m.ipContainer = m.top.findNode("ipContainer")
    m.ipFrame = m.top.findNode("ipFrame")

    m.sidebar = m.top.findNode("sidebar")
    m.sidebarBg = m.top.findNode("sidebarBg")
    m.sidebarEdge = m.top.findNode("sidebarEdge")
    m.sidebarLogoText = m.top.findNode("sidebarLogoText")
    m.sidebar.focusable = true
    navGroup = m.top.findNode("navItems")
    m.navHighlights = []
    m.navLabels = []
    m.sidebarFocused = false
    m.sidebarExpanded = false
    m.sidebarIndex = 0
    m.activeSidebar = 0

    m.authToken = ""
    m.authUserName = ""
    loadAuthToken()
    buildSidebar(navGroup)

    m.playerScreen = m.top.findNode("playerScreen")
    m.video = m.top.findNode("video")
    m.video.bufferMode = "normal"
    m.video.observeField("state", "onVideoStateChange")
    m.video.observeField("bufferingStatus", "onBufferingStatusChange")
    m.justExitedPlayer = false

    m.navStack = []

    m.gridItems = []
    m.channels = []
    m.rssItems = []

    m.odShows = {}
    m.odShowsList = []
    m.odGenres = {}
    m.odGenresList = []
    m.odDownloads = []
    m.odYtMusic = []

    m.currentPlayFilePath = ""
    m.currentPlayingItemType = "video"
    m.currentPlayingShow = ""
    m.currentPlayingSeason = invalid
    m.currentPlayingEpisode = invalid
    m.currentPlayingPoster = ""
    m.driveLibrary = invalid
    m.driveShows = {}
    m.driveShowsList = []
    m.driveMovies = []
    m.driveAutoPlayNextEnabled = false
    m.currentEpisodeList = invalid
    m.currentEpisodeIndex = -1
    m.driveMovieFolders = {}
    m.driveMovieFolderList = []
    m.pairingCode = ""
    m.pairingPollTask = invalid
    m.bufferingWatchdogTimer = invalid
    m.bufferingStallCount = 0
    m.lastBufferingPercent = 0

    m.searchMovieTorrents = []
    m.searchTvTorrents = []
    m.searchLibraryTv = []
    m.searchLibraryMovies = []
    m.searchChannels = []
    m.searchWhatson = []
    m.searchTasksPending = 0
    m.lastSearchQuery = ""

    m.top.setFocus(true)
    m.top.observeField("dialog", "onDialogClosed")

    m.notifGroup = m.top.findNode("notifGroup")
    m.notifTitle = m.top.findNode("notifTitle")
    m.notifMsg = m.top.findNode("notifMsg")
    m.notifTimer = m.top.findNode("notifTimer")
    m.notifTimer.observeField("fire", "onNotificationDismiss")

    t = CreateObject("roSGNode", "Timer")
    t.duration = 0.5
    t.observeField("fire", "onStartup")
    m.top.appendChild(t)
    t.control = "start"
end sub

sub onStartup()
    m.ipLabel.text = "Cloud"
    showHomeScreen()
end sub

' ---- Auth Token Management ----

sub loadAuthToken()
    reg = CreateObject("roRegistrySection", "FREEVEE")
    if reg.Exists("authToken")
        m.authToken = reg.Read("authToken")
    end if
    if reg.Exists("userName")
        m.authUserName = reg.Read("userName")
    end if
end sub

sub saveAuthToken(token as String, userName as String)
    reg = CreateObject("roRegistrySection", "FREEVEE")
    reg.Write("authToken", token)
    reg.Write("userName", userName)
    reg.Flush()
    m.authToken = token
    m.authUserName = userName
end sub

sub clearAuthToken()
    reg = CreateObject("roRegistrySection", "FREEVEE")
    if reg.Exists("authToken") then reg.Delete("authToken")
    if reg.Exists("userName") then reg.Delete("userName")
    reg.Flush()
    m.authToken = ""
    m.authUserName = ""
end sub

function isLoggedIn() as Boolean
    return m.authToken <> "" and m.authToken <> invalid
end function

function createAuthHttpTask() as Object
    task = CreateObject("roSGNode", "HttpTask")
    if isLoggedIn()
        task.authToken = m.authToken
    end if
    return task
end function

' ---- Sidebar Construction ----

sub buildSidebar(navGroup as Object)
    navGroup.removeChildrenIndex(navGroup.getChildCount(), 0)
    m.navHighlights = []
    m.navLabels = []

    navDefs = [
        { label: "Home", icon: "pkg:/images/icon-home.png" },
        { label: "Search", icon: "pkg:/images/icon-search.png" }
    ]
    if isLoggedIn()
        navDefs.push({ label: "Drive", icon: "pkg:/images/icon-grid.png" })
        navDefs.push({ label: "Faves", icon: "pkg:/images/icon-heart.png" })
    end if
    navDefs.push({ label: "Services", icon: "pkg:/images/icon-services.png" })
    navDefs.push({ label: "Free TV", icon: "pkg:/images/icon-live.png" })
    if isLoggedIn()
        navDefs.push({ label: "Sign Out", icon: "pkg:/images/icon-person.png" })
    else
        navDefs.push({ label: "Sign In", icon: "pkg:/images/icon-person.png" })
    end if

    for i = 0 to navDefs.count() - 1
        itemGroup = CreateObject("roSGNode", "Group")
        itemGroup.translation = [0, i * 52]

        hi = CreateObject("roSGNode", "Rectangle")
        hi.translation = [8, 0]
        hi.width = 60
        hi.height = 44
        hi.color = "0xFFFFFFFF"
        hi.opacity = 0.14
        hi.visible = false
        itemGroup.appendChild(hi)
        m.navHighlights.push(hi)

        icon = CreateObject("roSGNode", "Poster")
        icon.translation = [22, 6]
        icon.width = 32
        icon.height = 32
        icon.uri = navDefs[i].icon
        icon.loadDisplayMode = "scaleToFit"
        itemGroup.appendChild(icon)

        lbl = CreateObject("roSGNode", "Label")
        lbl.translation = [64, 6]
        lbl.width = 148
        lbl.height = 32
        lbl.text = navDefs[i].label
        lbl.font = "font:MediumSystemFont"
        lbl.color = "0xA3A8B8FF"
        lbl.vertAlign = "center"
        lbl.visible = false
        itemGroup.appendChild(lbl)
        m.navLabels.push(lbl)

        navGroup.appendChild(itemGroup)
    end for
    m.sidebarIndex = 0
    updateSidebarNav()
end sub

' ---- Login / Pairing Flow ----

sub showLoginScreen()
    m.activeSidebar = m.navLabels.count() - 1
    updateSidebarNav()
    pushCurrentState("Home > Sign In")
    m.folderBreadcrumb.text = "Loading pairing code..."

    m.pairingCodeTask = CreateObject("roSGNode", "HttpTask")
    m.pairingCodeTask.url = m.serverUrl + "/auth/device/code"
    m.pairingCodeTask.observeField("result", "onPairingCodeResult")
    m.pairingCodeTask.observeField("error", "onPairingCodeError")
    m.pairingCodeTask.control = "run"
end sub

sub onPairingCodeResult()
    if m.pairingCodeTask = invalid return
    result = m.pairingCodeTask.result
    if result = invalid or result = ""
        m.folderBreadcrumb.text = "Failed to generate pairing code"
        return
    end if
    data = ParseJSON(result)
    if data = invalid or data.code = invalid
        m.folderBreadcrumb.text = "Invalid pairing code response"
        return
    end if

    m.pairingCode = data.code
    m.pairingRetryCount = 0

    ' Show the QR code + big pairing code display
    if m.pairingCodeLabel <> invalid then m.pairingCodeLabel.text = m.pairingCode
    if m.pairingHint <> invalid then m.pairingHint.text = "or open " + m.serverUrl + "/device"

    m.posterGrid.visible = false
    m.heroGroup.visible = false
    m.cwLabel.visible = false
    m.cwGrid.visible = false
    
    if m.pairingGroup <> invalid then m.pairingGroup.visible = true
    if m.sidebar <> invalid then m.sidebar.setFocus(false)
    if m.posterGrid <> invalid then m.posterGrid.setFocus(false)

    m.folderBreadcrumb.text = "Sign In | Scan QR or open " + m.serverUrl + "/device and enter code " + m.pairingCode
    startPairingPoll()
end sub

sub startPairingPoll()
    if m.pairingCode = invalid or m.pairingCode = "" return
    if m.pairingRetryCount = invalid then m.pairingRetryCount = 0
    m.pairingPollTask = CreateObject("roSGNode", "PairingPollTask")
    m.pairingPollTask.serverUrl = m.serverUrl
    m.pairingPollTask.code = m.pairingCode
    m.pairingPollTask.observeField("result", "onPairingPollResult")
    m.pairingPollTask.control = "run"
end sub

sub onPairingPollResult()
    if m.pairingPollTask = invalid return
    result = m.pairingPollTask.result
    if result = invalid or result = "" return
    data = ParseJSON(result)
    if data = invalid return

    if data.status = "complete"
        token = data.token
        if token <> invalid and token <> ""
            if m.pairingGroup <> invalid then m.pairingGroup.visible = false
            saveAuthToken(token, "")
            m.folderBreadcrumb.text = "Signed in successfully!"
            navGroup = m.top.findNode("navItems")
            buildSidebar(navGroup)
            showHomeScreen()
        else
            m.folderBreadcrumb.text = "Failed to retrieve session token"
        end if
    else if data.status = "expired"
        m.folderBreadcrumb.text = "Pairing code expired. Go back to Sign In to try again."
        popState()
    else if data.status = "error" and data.error <> "" and m.pairingRetryCount < 3
        m.pairingRetryCount = m.pairingRetryCount + 1
        m.folderBreadcrumb.text = "Pairing check failed (" + data.error + "). Retrying..."
        startPairingPoll()
    else if data.status = "error"
        m.folderBreadcrumb.text = "Pairing check failed (" + data.error + "). Go back to Sign In and try again."
    end if
end sub

sub onPairingCodeError()
    m.folderBreadcrumb.text = "Error generating pairing code"
end sub

sub handleSignOut()
    clearAuthToken()
    m.activeSidebar = 0
    navGroup = m.top.findNode("navItems")
    buildSidebar(navGroup)
    showHomeScreen()
end sub

' ---- Home Screen ----

sub showHomeScreen()
    stopBackgroundPlayback()
    m.navStack = []
    m.folderBreadcrumb.text = "Home"
    m.isIpFocused = false
    updateIpHighlight()
    m.activeSidebar = 0
    updateSidebarNav()
    m.heroGroup.visible = true

    m.gridItems = []
    updateContinueWatchingGrid()

    m.posterGrid.visible = false
    if m.cwItems.count() > 0
        m.cwGrid.setFocus(true)
    else
        m.posterGrid.setFocus(true)
    end if
    m.state = "grid"
    loadHomeFresh()
end sub

' ---- Fresh Content Rail ----

sub updateContinueWatchingGrid()
    m.cwItems = []
    railContent = CreateObject("roSGNode", "ContentNode")

    hasFreshWhatson = m.homeFreshWhatsonData <> invalid and m.homeFreshWhatsonData.items <> invalid and m.homeFreshWhatsonData.items.count() > 0
    hasFreshMovie = m.homeFreshMovieData <> invalid and m.homeFreshMovieData.results <> invalid and m.homeFreshMovieData.results.count() > 0
    hasFreshTv = m.homeFreshTvData <> invalid and m.homeFreshTvData.results <> invalid and m.homeFreshTvData.results.count() > 0

    if hasFreshWhatson or hasFreshMovie or hasFreshTv
        if hasFreshWhatson
            for each item in m.homeFreshWhatsonData.items
                if item = invalid then continue for
                fTitle = safeStr(item.title)
                if fTitle = "" then fTitle = "Untitled"
                fNode = railContent.CreateChild("ContentNode")
                fNode.title = fTitle
                setPosterUrl(fNode, resolvePosterUrl(safeStr(item.image), "pkg:/images/no-poster.jpg"))
                fType = safeStr(item.type)
                yearStr = ""
                yStr = safeStr(item.year)
                if yStr <> "" and yStr <> "0" then yearStr = " (" + yStr + ")"
                fNode.shortDescriptionLine1 = fType + yearStr
                provider = safeStr(item.provider)
                if provider <> ""
                    fNode.description = fTitle + " - " + provider
                else
                    fNode.description = fTitle
                end if
                fNode.addFields({ targetType: "popular_item", itemTitle: fTitle, itemType: fType })
                m.cwItems.push(fNode)
            end for
        end if

        if hasFreshMovie
            for each item in m.homeFreshMovieData.results
                tNode = railContent.CreateChild("ContentNode")
                tNode.title = item.title
                setPosterUrl(tNode, resolvePosterUrl(safeStr(item.poster), "pkg:/images/no-poster.jpg"))
                tNode.shortDescriptionLine1 = item.quality
                tNode.description = item.title
                tNode.addFields({ targetType: "torrent_item", link: item.link, itemTitle: item.title })
                m.cwItems.push(tNode)
            end for
        end if

        if hasFreshTv
            for each item in m.homeFreshTvData.results
                tNode = railContent.CreateChild("ContentNode")
                tNode.title = item.title
                setPosterUrl(tNode, resolvePosterUrl(safeStr(item.poster), "pkg:/images/no-poster.jpg"))
                tNode.shortDescriptionLine1 = item.quality
                tNode.description = item.title
                tNode.addFields({ targetType: "torrent_item", link: item.link, itemTitle: item.title })
                m.cwItems.push(tNode)
            end for
        end if
    end if

    showRail = (m.cwItems.count() > 0) and (m.navStack.count() = 0) and (m.state = "grid")
    m.cwLabel.visible = false
    m.cwGrid.visible = showRail
    if m.cwItems.count() > 0
        m.cwGrid.content = railContent
        m.cwGrid.jumpToItem = 0
    end if

    ' Fresh home data commonly arrives after showHomeScreen already tried to
    ' focus an empty (invisible) grid, so nothing has focus and the D-pad is
    ' dead until the user opens/closes the sidebar. Claim focus on the rail.
    if showRail and m.top.dialog = invalid and not m.sidebarFocused and not m.isIpFocused and not m.cwGrid.hasFocus()
        m.cwGrid.setFocus(true)
    end if
end sub

sub loadHomeFresh()
    if m.serverUrl = "" then return
    if m.homeFreshLoading = true then return
    m.homeFreshLoading = true
    m.homeFreshReadyCount = 0
    m.homeFreshWhatsonData = invalid
    m.homeFreshMovieData = invalid
    m.homeFreshTvData = invalid

    m.homeFreshWhatsonTask = CreateObject("roSGNode", "HttpTask")
    m.homeFreshWhatsonTask.url = m.serverUrl + "/api/whatson?roku=1"
    m.homeFreshWhatsonTask.observeField("result", "onHomeFreshWhatsonResult")
    m.homeFreshWhatsonTask.observeField("error", "onHomeFreshWhatsonResult")
    m.homeFreshWhatsonTask.control = "run"

    m.homeFreshMovieTask = CreateObject("roSGNode", "HttpTask")
    m.homeFreshMovieTask.url = m.serverUrl + "/api/movie-streams"
    m.homeFreshMovieTask.observeField("result", "onHomeFreshMovieResult")
    m.homeFreshMovieTask.observeField("error", "onHomeFreshMovieResult")
    m.homeFreshMovieTask.control = "run"

    m.homeFreshTvTask = CreateObject("roSGNode", "HttpTask")
    m.homeFreshTvTask.url = m.serverUrl + "/api/tv-streams"
    m.homeFreshTvTask.observeField("result", "onHomeFreshTvResult")
    m.homeFreshTvTask.observeField("error", "onHomeFreshTvResult")
    m.homeFreshTvTask.control = "run"
end sub

sub onHomeFreshWhatsonResult()
    if m.homeFreshWhatsonTask <> invalid
        result = m.homeFreshWhatsonTask.result
        if result <> invalid and result <> "" then m.homeFreshWhatsonData = ParseJSON(result)
    end if
    m.homeFreshReadyCount = m.homeFreshReadyCount + 1
    if m.homeFreshReadyCount >= 3
        m.homeFreshLoading = false
        updateContinueWatchingGrid()
    end if
end sub

sub onHomeFreshMovieResult()
    if m.homeFreshMovieTask <> invalid
        result = m.homeFreshMovieTask.result
        if result <> invalid and result <> "" then m.homeFreshMovieData = ParseJSON(result)
    end if
    m.homeFreshReadyCount = m.homeFreshReadyCount + 1
    if m.homeFreshReadyCount >= 3
        m.homeFreshLoading = false
        updateContinueWatchingGrid()
    end if
end sub

sub onHomeFreshTvResult()
    if m.homeFreshTvTask <> invalid
        result = m.homeFreshTvTask.result
        if result <> invalid and result <> "" then m.homeFreshTvData = ParseJSON(result)
    end if
    m.homeFreshReadyCount = m.homeFreshReadyCount + 1
    if m.homeFreshReadyCount >= 3
        m.homeFreshLoading = false
        updateContinueWatchingGrid()
    end if
end sub

sub onCwFocused()
    focusedIdx = m.cwGrid.itemFocused
    if focusedIdx >= 0 and focusedIdx < m.cwItems.count()
        item = m.cwItems[focusedIdx]
        if m.detailTitle <> invalid and item.title <> invalid then m.detailTitle.text = item.title
        if m.detailDesc <> invalid and item.description <> invalid then m.detailDesc.text = item.description
        if m.heroTitle <> invalid and item.title <> invalid and item.title <> "" then m.heroTitle.text = item.title
        if m.heroDesc <> invalid and item.description <> invalid and item.description <> "" then m.heroDesc.text = item.description
        if m.homeBg <> invalid and item.HDPosterUrl <> invalid and item.HDPosterUrl <> ""
            m.homeBg.loadDisplayMode = "zoomToFill"
            m.homeBg.uri = item.HDPosterUrl
        end if
        if m.cwInfoBar <> invalid and item.targetType <> "section_header"
            m.cwInfoBar.visible = true
            m.cwInfoTitle.visible = true
            m.cwInfoDesc.visible = true
            if item.title <> invalid then m.cwInfoTitle.text = item.title
            if item.description <> invalid and item.description <> ""
                m.cwInfoDesc.text = item.description
            else
                m.cwInfoDesc.text = ""
            end if
        else if m.cwInfoBar <> invalid
            m.cwInfoBar.visible = false
            m.cwInfoTitle.visible = false
            m.cwInfoDesc.visible = false
        end if

        stopBackgroundPlayback()
    end if
end sub

sub onCwSelected()
    selectedIdx = m.cwGrid.itemSelected
    if selectedIdx < 0 or selectedIdx >= m.cwItems.count() then return
    item = m.cwItems[selectedIdx]
    tType = item.targetType

    if tType = "section_header"
        return
    else if tType = "popular_item"
        searchPopularTorrent(item)
        return
    else if tType = "torrent_item"
        linkUrl = ""
        if item.link <> invalid then linkUrl = item.link.toStr()
        itemTitle = ""
        if item.itemTitle <> invalid then itemTitle = item.itemTitle.toStr()
        if itemTitle = "" and item.title <> invalid then itemTitle = item.title.toStr()
        playTorrentStream(linkUrl, itemTitle)
        return
    end if
end sub

' ---- Drive Section ----

sub openDriveGrid()
    if not isLoggedIn()
        showLoginScreen()
        return
    end if
    m.activeSidebar = 2
    updateSidebarNav()
    pushCurrentState("Home > Drive")
    m.folderBreadcrumb.text = "Loading Drive library..."

    m.driveLibTask = CreateAuthHttpTask()
    m.driveLibTask.url = m.serverUrl + "/api/ondemand"
    m.driveLibTask.observeField("result", "onDriveLibraryResult")
    m.driveLibTask.observeField("error", "onDriveLibraryError")
    m.driveLibTask.control = "run"
end sub

sub onDriveLibraryResult()
    if m.driveLibTask = invalid return
    result = m.driveLibTask.result
    if result = invalid or result = ""
        m.folderBreadcrumb.text = "Failed to load Drive library"
        return
    end if
    data = ParseJSON(result)
    if data = invalid
        m.folderBreadcrumb.text = "Invalid Drive library response"
        return
    end if

    m.driveLibrary = data
    m.driveShows = {}
    m.driveShowsList = []
    m.driveMovies = []
    m.driveMovieFolders = {}
    m.driveMovieFolderList = []

    if data.shows <> invalid then m.driveShows = data.shows
    if data.showsList <> invalid then m.driveShowsList = data.showsList
    if data.movies <> invalid then m.driveMovies = data.movies
    if data.movieFolders <> invalid then m.driveMovieFolders = data.movieFolders
    if data.movieFolderList <> invalid then m.driveMovieFolderList = data.movieFolderList
    if data.hlsChunkSeconds <> invalid and data.hlsChunkSeconds > 0
        m.serverChunkSeconds = data.hlsChunkSeconds
    end if

    ' Fallback: group movies by folder if not grouped by server
    if m.driveMovieFolderList.count() = 0 and m.driveMovies.count() > 0
        for each movie in m.driveMovies
            fName = ""
            if movie.folder <> invalid and movie.folder <> ""
                fName = movie.folder.toStr()
            else if movie.folderPath <> invalid and movie.folderPath <> ""
                fName = movie.folderPath.toStr()
            end if
            if fName <> ""
                topFolder = fName
                slashIdx = Instr(1, fName, "/")
                if slashIdx > 1 then topFolder = Left(fName, slashIdx - 1)
                slashIdx = Instr(1, topFolder, "\")
                if slashIdx > 1 then topFolder = Left(topFolder, slashIdx - 1)
                topFolder = topFolder.trim()
                if topFolder <> ""
                    if m.driveMovieFolders[topFolder] = invalid
                        m.driveMovieFolders[topFolder] = []
                        m.driveMovieFolderList.push(topFolder)
                    end if
                    m.driveMovieFolders[topFolder].push(movie)
                end if
            end if
        end for
        m.driveMovieFolderList.sort()
    end if

    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    if m.driveShowsList.count() > 0
        showsNode = gridContent.CreateChild("ContentNode")
        showsNode.title = "TV Shows"
        setPosterUrl(showsNode, "pkg:/images/tv-shows.jpg")
        showsNode.shortDescriptionLine1 = Stri(m.driveShowsList.count()).trim() + " Shows"
        showsNode.description = "Browse your TV show library from Google Drive"
        showsNode.addFields({ targetType: "drive_tv_root" })
        m.gridItems.push(showsNode)
    end if

    if m.driveMovies.count() > 0
        moviesNode = gridContent.CreateChild("ContentNode")
        moviesNode.title = "Movies"
        setPosterUrl(moviesNode, "pkg:/images/movies.jpg")
        if m.driveMovieFolderList <> invalid and m.driveMovieFolderList.count() > 0
            moviesNode.shortDescriptionLine1 = Stri(m.driveMovieFolderList.count()).trim() + " Folders (" + Stri(m.driveMovies.count()).trim() + " Movies)"
        else
            moviesNode.shortDescriptionLine1 = Stri(m.driveMovies.count()).trim() + " Movies"
        end if
        moviesNode.description = "Browse your movie library from Google Drive"
        moviesNode.addFields({ targetType: "drive_movies_root" })
        m.gridItems.push(moviesNode)
    end if

    cwData = []
    if data.continueWatching <> invalid
        for each item in data.continueWatching
            if item <> invalid then cwData.push(item)
        end for
    end if
    if cwData.count() > 0
        cwNode = gridContent.CreateChild("ContentNode")
        cwNode.title = "Continue Watching"
        setPosterUrl(cwNode, "pkg:/images/continue-watching.jpg")
        cwNode.shortDescriptionLine1 = Stri(cwData.count()).trim() + " Items"
        cwNode.description = "Resume watching where you left off"
        cwNode.addFields({ targetType: "drive_continue_watching" })
        m.gridItems.push(cwNode)
    end if

    if m.gridItems.count() = 0
        m.folderBreadcrumb.text = "Drive library is empty. Set up folders in the web app."
        return
    end if

    m.folderBreadcrumb.text = "Home > Drive (" + Stri(m.gridItems.count()).trim() + " Sections)"
    m.posterGrid.basePosterSize = [180, 240]
    m.posterGrid.itemSpacing = [24, 16]
    m.posterGrid.numColumns = 5
    m.posterGrid.numRows = 2
    m.posterGrid.translation = [20, 76]
    m.posterGrid.content = gridContent
    m.posterGrid.visible = true
    m.heroGroup.visible = false
    m.cwLabel.visible = false
    m.cwGrid.visible = false
    
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub onDriveLibraryError()
    m.folderBreadcrumb.text = "Error loading Drive library"
end sub

sub openDriveShowsGrid()
    if m.driveShowsList = invalid or m.driveShowsList.count() = 0 return
    pushCurrentState("Home > Drive > TV Shows")
    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    for each showName in m.driveShowsList
        seasons = m.driveShows[showName]
        if seasons = invalid then continue for
        totalEps = 0
        for each sKey in seasons
            eps = seasons[sKey]
            if eps <> invalid then totalEps = totalEps + eps.count()
        end for
        if totalEps = 0 then continue for

        node = gridContent.CreateChild("ContentNode")
        node.title = showName
        posterUrl = "pkg:/images/tv-shows.jpg"
        if m.driveLibrary <> invalid and m.driveLibrary.showsPosters <> invalid and m.driveLibrary.showsPosters[showName] <> invalid
            posterUrl = m.driveLibrary.showsPosters[showName]
        end if
        setPosterUrl(node, posterUrl)
        node.shortDescriptionLine1 = Stri(totalEps).trim() + " Episodes"
        node.description = showName + " - " + Stri(seasons.count()).trim() + " seasons, " + Stri(totalEps).trim() + " episodes"
        node.addFields({ targetType: "drive_show", showName: showName, seasons: seasons })
        m.gridItems.push(node)
    end for

    m.folderBreadcrumb.text = "Home > Drive > TV Shows (" + Stri(m.gridItems.count()).trim() + ")"
    m.posterGrid.basePosterSize = [165, 270]
    m.posterGrid.itemSpacing = [20, 14]
    m.posterGrid.numColumns = 6
    m.posterGrid.numRows = 2
    m.posterGrid.translation = [20, 76]
    m.posterGrid.content = gridContent
    m.posterGrid.visible = true
    m.heroGroup.visible = false
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub openDriveShowSeasons(showName as String, seasons as Object, crumbPrefix = "Home > Drive > " as String)
    pushCurrentState(crumbPrefix + showName)
    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    seasonKeys = []
    for each sKey in seasons
        sInt = safeInt(sKey)
        if sInt > 0 then seasonKeys.push(sInt)
    end for
    seasonKeys.sort()

    posterUrl = "pkg:/images/tv-shows.jpg"
    if m.driveLibrary <> invalid and m.driveLibrary.showsPosters <> invalid and m.driveLibrary.showsPosters[showName] <> invalid
        posterUrl = m.driveLibrary.showsPosters[showName]
    end if

    ' Find latest episode across all seasons in this show
    latestSeasonNum = -1
    latestEpNum = -1
    latestEpObj = invalid
    for each sNum in seasonKeys
        sKey = Stri(sNum).trim()
        eps = seasons[sKey]
        if eps <> invalid
            for each ep in eps
                curEpNum = safeInt(ep.episode)
                if sNum > latestSeasonNum or (sNum = latestSeasonNum and curEpNum > latestEpNum)
                    latestSeasonNum = sNum
                    latestEpNum = curEpNum
                    latestEpObj = ep
                end if
            end for
        end if
    end for

    ' Add "★ Latest Episode" card if found
    if latestEpObj <> invalid and latestSeasonNum > 0
        latestNode = buildDriveEpisodeNode(showName, Stri(latestSeasonNum).trim(), latestEpObj)
        if latestNode <> invalid
            latestCard = gridContent.CreateChild("ContentNode")
            latestCard.title = "★ Latest: " + latestNode.title
            setPosterUrl(latestCard, "pkg:/images/star.jpg")
            latestCard.shortDescriptionLine1 = "Quick Play · Latest Episode"
            latestCard.description = "Play latest episode: " + latestNode.title
            latestCard.addFields({
                targetType: "drive_episode",
                showName: showName,
                seasonNum: Stri(latestSeasonNum).trim(),
                episodeNum: latestNode.episodeNum,
                itemTitle: latestNode.itemTitle,
                mediaPath: latestNode.mediaPath,
                driveId: latestNode.driveId,
                filename: latestNode.filename
            })
            m.gridItems.push(latestCard)
        end if
    end if

    for each sNum in seasonKeys
        sKey = Stri(sNum).trim()
        eps = seasons[sKey]
        if eps = invalid or eps.count() = 0 then continue for
        node = gridContent.CreateChild("ContentNode")
        node.title = "Season " + sKey
        setPosterUrl(node, posterUrl)
        node.shortDescriptionLine1 = Stri(eps.count()).trim() + " Episodes"
        node.description = showName + " - Season " + sKey + " (" + Stri(eps.count()).trim() + " episodes)"
        node.addFields({ targetType: "drive_season", showName: showName, seasonNum: sKey, episodes: eps, crumbPrefix: crumbPrefix })
        m.gridItems.push(node)
    end for

    m.folderBreadcrumb.text = crumbPrefix + showName + " (" + Stri(seasonKeys.count()).trim() + " Seasons)"
    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub openDriveSeasonEpisodes(showName as String, seasonNum as String, episodes as Object, crumbPrefix = "Home > Drive > " as String)
    if episodes = invalid or episodes.count() = 0 then return
    pushCurrentState(crumbPrefix + showName + " > Season " + seasonNum)
    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []
    m.driveAutoPlayNextEnabled = true

    sortedEps = []
    for each epItem in episodes
        sortedEps.push(epItem)
    end for
    ' Bubble sort by episode number (BrightScript-safe)
    n = sortedEps.count()
    for i = 0 to n - 2
        for j = 0 to n - i - 2
            eA = safeInt(sortedEps[j].episode)
            eB = safeInt(sortedEps[j + 1].episode)
            if eA > eB
                tmp = sortedEps[j]
                sortedEps[j] = sortedEps[j + 1]
                sortedEps[j + 1] = tmp
            end if
        end for
    end for

    for each ep in sortedEps
        node = buildDriveEpisodeNode(showName, seasonNum, ep)
        if node <> invalid
            gridContent.appendChild(node)
            m.gridItems.push(node)
        end if
    end for

    m.folderBreadcrumb.text = crumbPrefix + showName + " > S" + seasonNum + " (" + Stri(episodes.count()).trim() + " Episodes)"
    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

function buildDriveEpisodeNode(showName as String, seasonNum as String, ep as Object) as Object
    if ep = invalid return invalid
    node = CreateObject("roSGNode", "ContentNode")
    eNum = safeInt(ep.episode)
    eNumStr = Right(Stri(100 + eNum).trim(), 2)
    epTitle = safeStr(ep.title)
    if epTitle = "" then epTitle = "Episode " + Stri(eNum).trim()
    fullTitle = "S" + seasonNum + "E" + eNumStr + " - " + epTitle
    node.title = fullTitle

    posterUrl = "pkg:/images/tv-shows.jpg"
    if ep.thumbnailUrl <> invalid and ep.thumbnailUrl <> ""
        posterUrl = ep.thumbnailUrl
    else if m.driveLibrary <> invalid and m.driveLibrary.showsPosters <> invalid and m.driveLibrary.showsPosters[showName] <> invalid
        posterUrl = m.driveLibrary.showsPosters[showName]
    end if
    setPosterUrl(node, posterUrl)
    node.shortDescriptionLine1 = "Episode " + Stri(eNum).trim()
    node.description = showName + " - " + fullTitle

    node.addFields({
        targetType: "drive_episode"
        showName: showName
        seasonNum: seasonNum
        episodeNum: Stri(eNum).trim()
        itemTitle: fullTitle
        mediaPath: safeStr(ep.path)
        driveId: safeStr(ep.driveId)
        filename: safeStr(ep.filename)
    })
    return node
end function

' Snapshot the current episode grid so playback can advance to the next item.
sub prepareEpisodeAutoPlay(selectedIdx as Integer)
    if m.driveAutoPlayNextEnabled <> true or m.gridItems = invalid or selectedIdx < 0 or selectedIdx >= m.gridItems.count()
        m.currentEpisodeList = invalid
        m.currentEpisodeIndex = -1
        return
    end if
    m.currentEpisodeList = []
    for each epNode in m.gridItems
        if epNode <> invalid then m.currentEpisodeList.push(epNode)
    end for
    m.currentEpisodeIndex = selectedIdx
end sub

' Auto-play the next episode in the current season, or roll into the next season
' when this season is exhausted. Returns true if playback started.
function playNextDriveEpisode() as Boolean
    if m.currentPlayingItemType <> "tv" then return false
    if m.currentEpisodeList = invalid or m.currentEpisodeList.count() = 0 then return false
    savedList = m.currentEpisodeList

    nextIdx = -1
    if m.currentEpisodeIndex >= 0 and m.currentEpisodeIndex < savedList.count()
        nextIdx = m.currentEpisodeIndex + 1
    else
        curSeason = safeStr(m.currentPlayingSeason)
        curEp = safeStr(m.currentPlayingEpisode)
        for i = 0 to savedList.count() - 1
            node = savedList[i]
            if node = invalid then continue for
            sMatch = (curSeason = "") or (node.seasonNum <> invalid and safeStr(node.seasonNum) = curSeason)
            eMatch = (curEp = "") or (node.episodeNum <> invalid and safeStr(node.episodeNum) = curEp)
            if sMatch and eMatch
                nextIdx = i + 1
                exit for
            end if
        end for
    end if

    if nextIdx >= 0 and nextIdx < savedList.count()
        nextItem = savedList[nextIdx]
        if nextItem <> invalid
            stopAllActiveStreams()
            m.video.control = "stop"
            setDriveItemMeta(nextItem)
            playDriveItem(nextItem)
            m.currentEpisodeList = savedList
            m.currentEpisodeIndex = nextIdx
            return true
        end if
    end if

    ' End of this season - continue into the next available season
    if m.currentPlayingShow <> invalid and m.currentPlayingShow <> "" and m.driveShows <> invalid
        seasons = m.driveShows[m.currentPlayingShow]
        if seasons <> invalid
            curSeasonNum = safeInt(m.currentPlayingSeason)
            seasonKeys = []
            for each sKey in seasons
                seasonKeys.push(safeInt(sKey))
            end for
            seasonKeys.sort()
            for each sNum in seasonKeys
                if sNum > curSeasonNum
                    sKeyStr = Stri(sNum).trim()
                    eps = seasons[sKeyStr]
                    if eps = invalid or eps.count() = 0 then continue for
                    nextSeasonList = []
                    for each epItem in eps
                        node = buildDriveEpisodeNode(m.currentPlayingShow, sKeyStr, epItem)
                        if node <> invalid then nextSeasonList.push(node)
                    end for
                    if nextSeasonList.count() > 0
                        stopAllActiveStreams()
                        m.video.control = "stop"
                        setDriveItemMeta(nextSeasonList[0])
                        playDriveItem(nextSeasonList[0])
                        m.currentEpisodeList = nextSeasonList
                        m.currentEpisodeIndex = 0
                        return true
                    end if
                end if
            end for
        end if
    end if

    return false
end function

function getDriveMoviePoster(movie as Object) as String
    if movie = invalid return "pkg:/images/movies.jpg"
    p = ""
    if movie.posterUrl <> invalid and movie.posterUrl <> ""
        p = safeStr(movie.posterUrl)
    end if
    if p = "" and m.driveLibrary <> invalid and m.driveLibrary.moviesPosters <> invalid
        if movie.title <> invalid and m.driveLibrary.moviesPosters[movie.title] <> invalid
            p = safeStr(m.driveLibrary.moviesPosters[movie.title])
        else if movie.driveId <> invalid and m.driveLibrary.moviesPosters[movie.driveId] <> invalid
            p = safeStr(m.driveLibrary.moviesPosters[movie.driveId])
        end if
    end if
    if p = "" and movie.thumbnailUrl <> invalid and movie.thumbnailUrl <> ""
        p = safeStr(movie.thumbnailUrl)
    end if
    if p = "" then p = "pkg:/images/movies.jpg"
    return p
end function

sub openDriveMoviesGrid()
    if m.driveMovies = invalid or m.driveMovies.count() = 0 return
    pushCurrentState("Home > Drive > Movies")
    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    hasFolders = (m.driveMovieFolderList <> invalid and m.driveMovieFolderList.count() > 0)

    if hasFolders
        ' 1. Display each Google Drive folder as a card
        for each folderName in m.driveMovieFolderList
            folderMovies = m.driveMovieFolders[folderName]
            if folderMovies = invalid or folderMovies.count() = 0 then continue for

            node = gridContent.CreateChild("ContentNode")
            node.title = folderName

            ' Use poster of first movie in this folder if available
            folderPoster = "pkg:/images/movies.jpg"
            for each mItem in folderMovies
                p = getDriveMoviePoster(mItem)
                if p <> "pkg:/images/movies.jpg"
                    folderPoster = p
                    exit for
                end if
            end for
            setPosterUrl(node, folderPoster)

            node.shortDescriptionLine1 = Stri(folderMovies.count()).trim() + " Movies"
            node.description = folderName + " - " + Stri(folderMovies.count()).trim() + " movies"
            node.addFields({
                targetType: "drive_movie_folder",
                folderName: folderName,
                movies: folderMovies
            })
            m.gridItems.push(node)
        end for

        ' 2. Display any loose movies located directly in root (no folder)
        for each movie in m.driveMovies
            if movie = invalid then continue for
            mFolder = ""
            if movie.folder <> invalid then mFolder = movie.folder.toStr().trim()
            if mFolder = ""
                node = gridContent.CreateChild("ContentNode")
                node.title = safeStr(movie.title)
                posterUrl = getDriveMoviePoster(movie)
                setPosterUrl(node, posterUrl)
                yearStr = ""
                yStr = safeStr(movie.year)
                if yStr <> "" and yStr <> "0" then yearStr = " (" + yStr + ")"
                node.shortDescriptionLine1 = "Movie" + yearStr
                node.description = safeStr(movie.title) + yearStr
                node.addFields({
                    targetType: "drive_movie",
                    itemTitle: safeStr(movie.title),
                    mediaPath: safeStr(movie.path),
                    driveId: safeStr(movie.driveId),
                    filename: safeStr(movie.filename),
                    posterUrl: posterUrl
                })
                m.gridItems.push(node)
            end if
        end for

        ' 3. Display an "All Movies" tile
        allNode = gridContent.CreateChild("ContentNode")
        allNode.title = "All Movies"
        setPosterUrl(allNode, "pkg:/images/movies.jpg")
        allNode.shortDescriptionLine1 = Stri(m.driveMovies.count()).trim() + " Movies"
        allNode.description = "Browse all " + Stri(m.driveMovies.count()).trim() + " movies in a single list"
        allNode.addFields({ targetType: "drive_all_movies" })
        m.gridItems.push(allNode)

        m.folderBreadcrumb.text = "Home > Drive > Movies (" + Stri(m.driveMovieFolderList.count()).trim() + " Folders)"
    else
        ' Flat list if no folders exist
        for each movie in m.driveMovies
            if movie = invalid then continue for
            node = gridContent.CreateChild("ContentNode")
            node.title = safeStr(movie.title)
            posterUrl = getDriveMoviePoster(movie)
            setPosterUrl(node, posterUrl)
            yearStr = ""
            yStr = safeStr(movie.year)
            if yStr <> "" and yStr <> "0" then yearStr = " (" + yStr + ")"
            node.shortDescriptionLine1 = "Movie" + yearStr
            node.description = safeStr(movie.title) + yearStr
            node.addFields({
                targetType: "drive_movie",
                itemTitle: safeStr(movie.title),
                mediaPath: safeStr(movie.path),
                driveId: safeStr(movie.driveId),
                filename: safeStr(movie.filename),
                posterUrl: posterUrl
            })
            m.gridItems.push(node)
        end for
        m.folderBreadcrumb.text = "Home > Drive > Movies (" + Stri(m.gridItems.count()).trim() + ")"
    end if

    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub openDriveMovieFolderGrid(folderName as String, movies as Object)
    if movies = invalid or movies.count() = 0 return
    pushCurrentState("Home > Drive > Movies > " + folderName)
    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    for each movie in movies
        if movie = invalid then continue for
        node = gridContent.CreateChild("ContentNode")
        node.title = safeStr(movie.title)
        posterUrl = getDriveMoviePoster(movie)
        setPosterUrl(node, posterUrl)
        yearStr = ""
        yStr = safeStr(movie.year)
        if yStr <> "" and yStr <> "0" then yearStr = " (" + yStr + ")"
        node.shortDescriptionLine1 = "Movie" + yearStr
        node.description = safeStr(movie.title) + yearStr
        node.addFields({
            targetType: "drive_movie",
            itemTitle: safeStr(movie.title),
            mediaPath: safeStr(movie.path),
            driveId: safeStr(movie.driveId),
            filename: safeStr(movie.filename),
            posterUrl: posterUrl
        })
        m.gridItems.push(node)
    end for

    m.folderBreadcrumb.text = "Home > Drive > Movies > " + folderName + " (" + Stri(m.gridItems.count()).trim() + ")"
    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub openDriveAllMoviesGrid()
    if m.driveMovies = invalid or m.driveMovies.count() = 0 return
    pushCurrentState("Home > Drive > Movies > All Movies")
    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    for each movie in m.driveMovies
        if movie = invalid then continue for
        node = gridContent.CreateChild("ContentNode")
        node.title = safeStr(movie.title)
        posterUrl = getDriveMoviePoster(movie)
        setPosterUrl(node, posterUrl)
        yearStr = ""
        yStr = safeStr(movie.year)
        if yStr <> "" and yStr <> "0" then yearStr = " (" + yStr + ")"
        node.shortDescriptionLine1 = "Movie" + yearStr
        node.description = safeStr(movie.title) + yearStr
        node.addFields({
            targetType: "drive_movie",
            itemTitle: safeStr(movie.title),
            mediaPath: safeStr(movie.path),
            driveId: safeStr(movie.driveId),
            filename: safeStr(movie.filename),
            posterUrl: posterUrl
        })
        m.gridItems.push(node)
    end for

    m.folderBreadcrumb.text = "Home > Drive > All Movies (" + Stri(m.gridItems.count()).trim() + ")"
    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub playDriveItem(item as Object)
    if item = invalid return
    m.currentEpisodeList = invalid
    m.currentEpisodeIndex = -1
    driveId = ""
    mediaPath = ""
    title = ""
    offset = 0
    filename = ""

    if item.hasField("driveId") and item.driveId <> invalid then driveId = item.driveId.toStr()
    if item.hasField("mediaPath") and item.mediaPath <> invalid then mediaPath = item.mediaPath.toStr()
    if item.hasField("filename") and item.filename <> invalid then filename = item.filename.toStr()
    if item.hasField("itemTitle") and item.itemTitle <> invalid
        title = item.itemTitle.toStr()
    else if item.title <> invalid
        title = item.title.toStr()
    end if
    if item.hasField("currentTime") and item.currentTime <> invalid then offset = safeInt(item.currentTime)

    if driveId = "" and Len(mediaPath) >= 8 and Left(mediaPath, 8) = "drive://"
        driveId = Mid(mediaPath, 9)
    end if

    if driveId <> ""
        dt = CreateObject("roDateTime")
        m.playStartWallClock = dt.asSeconds().toStr()
        m.currentPlayFilePath = mediaPath
        m.currentPlayFilename = filename

        ' Always transcode Drive content to HLS via the cloud server.
        ' Direct /api/stream/drive/ progressive playback fails on many Roku
        ' devices (aborted connections), so every Drive video is sent through
        ' the drive-hls transcode pipeline that every Roku can decode.
        streamUrl = m.serverUrl + "/api/stream/drive-hls/" + driveId + ".m3u8"
        if isLoggedIn()
            streamUrl = streamUrl + "?token=" + m.authToken
        end if
        if offset > 0
            if Instr(1, streamUrl, "?") > 0
                streamUrl = streamUrl + "&offset=" + Stri(Fix(offset)).trim()
            else
                streamUrl = streamUrl + "?offset=" + Stri(Fix(offset)).trim()
            end if
        end if
        playVideoUrl(streamUrl, title, offset, filename, true)
    end if
end sub

' ---- Favorites Section ----

sub openFavoritesGrid()
    if not isLoggedIn()
        showLoginScreen()
        return
    end if
    m.activeSidebar = 3
    updateSidebarNav()
    pushCurrentState("Home > Favorites")
    m.folderBreadcrumb.text = "Loading favorites..."

    m.favesTask = CreateAuthHttpTask()
    m.favesTask.url = m.serverUrl + "/api/favorites"
    m.favesTask.observeField("result", "onFavoritesResult")
    m.favesTask.observeField("error", "onFavoritesError")
    m.favesTask.control = "run"
end sub

sub onFavoritesResult()
    if m.favesTask = invalid return
    result = m.favesTask.result
    if result = invalid or result = ""
        m.folderBreadcrumb.text = "Failed to load favorites"
        return
    end if
    data = ParseJSON(result)
    if data = invalid or data.favorites = invalid or data.favorites.count() = 0
        m.folderBreadcrumb.text = "No favorites yet. Heart items from the Drive section to add them here."
        gridContent = CreateObject("roSGNode", "ContentNode")
        m.gridItems = []
        emptyNode = gridContent.CreateChild("ContentNode")
        emptyNode.title = "No Favorites"
        setPosterUrl(emptyNode, "pkg:/images/icon-heart.png")
        emptyNode.shortDescriptionLine1 = "Empty"
        emptyNode.description = "Go to Drive and heart items to add them to favorites"
        emptyNode.addFields({ targetType: "section_header" })
        m.gridItems.push(emptyNode)
        m.posterGrid.content = gridContent
        m.posterGrid.visible = true
        m.heroGroup.visible = false
        m.cwLabel.visible = false
        m.cwGrid.visible = false
        m.posterGrid.setFocus(true)
        return
    end if

    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    for each fav in data.favorites
        if fav = invalid then continue for
        node = gridContent.CreateChild("ContentNode")
        favTitle = safeStr(fav.title)
        if favTitle = "" then favTitle = "Untitled"
        node.title = favTitle
        favImage = safeStr(fav.image)
        if favImage = ""
            setPosterUrl(node, "pkg:/images/no-poster.jpg")
        else if LCase(favImage).left(4) = "http"
            setPosterUrl(node, favImage)
        else if LCase(favImage).left(4) = "pkg:"
            setPosterUrl(node, favImage)
        else
            setPosterUrl(node, m.serverUrl + favImage)
        end if
        favType = safeStr(fav.type)
        if favType = "" then favType = "movie"
        showName = safeStr(fav.show)
        isShowFav = (favType = "show" or favType = "tv")
        if not isShowFav and showName <> "" and safeStr(fav.driveId) = "" and safeStr(fav.path) = ""
            isShowFav = true
        end if
        if isShowFav
            node.shortDescriptionLine1 = "TV Show"
            sName = showName
            if sName = "" then sName = favTitle
            node.addFields({
                targetType: "fave_show",
                showName: sName,
                itemTitle: favTitle,
                itemType: "tv",
                HDPosterUrl: favImage,
                posterUrl: favImage
            })
        else if safeStr(fav.driveId) <> "" or safeStr(fav.path) <> ""
            node.shortDescriptionLine1 = "Drive Movie"
            node.addFields({
                targetType: "drive_movie",
                itemTitle: favTitle,
                mediaPath: safeStr(fav.path),
                driveId: safeStr(fav.driveId),
                itemType: favType,
                HDPosterUrl: favImage,
                posterUrl: favImage
            })
        else
            node.shortDescriptionLine1 = "Movie"
            node.addFields({
                targetType: "popular_item",
                itemTitle: favTitle,
                itemType: favType,
                HDPosterUrl: favImage,
                posterUrl: favImage
            })
        end if
        node.description = favTitle
        m.gridItems.push(node)
    end for

    m.folderBreadcrumb.text = "Home > Favorites (" + Stri(m.gridItems.count()).trim() + ")"
    m.posterGrid.basePosterSize = [165, 270]
    m.posterGrid.itemSpacing = [20, 14]
    m.posterGrid.numColumns = 6
    m.posterGrid.numRows = 2
    m.posterGrid.translation = [20, 76]
    m.posterGrid.content = gridContent
    m.posterGrid.visible = true
    m.heroGroup.visible = false
    m.cwLabel.visible = false
    m.cwGrid.visible = false
    
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub onFavoritesError()
    m.folderBreadcrumb.text = "Error loading favorites"
end sub

sub toggleFavorite(item as Object)
    if not isLoggedIn()
        showNotification("Sign In Required", "Please sign in to save favorites")
        return
    end if
    if item = invalid then return

    favTitle = ""
    if item.hasField("itemTitle") and item.itemTitle <> invalid then favTitle = safeStr(item.itemTitle)
    if favTitle = "" and item.hasField("showTitle") and item.showTitle <> invalid then favTitle = safeStr(item.showTitle)
    if favTitle = "" and item.hasField("showName") and item.showName <> invalid then favTitle = safeStr(item.showName)
    if favTitle = "" and item.hasField("title") and item.title <> invalid then favTitle = safeStr(item.title)
    if favTitle = "" then return

    favType = ""
    if item.hasField("itemType") and item.itemType <> invalid then favType = safeStr(item.itemType)
    tType = safeStr(item.targetType)
    if tType = "drive_show" or tType = "fave_show" or tType = "popular_tv_season" or tType = "service_tv_item" or tType = "service_tv_season"
        favType = "show"
    else if tType = "service_movie_item" or tType = "drive_movie"
        favType = "movie"
    else if tType = "drive_episode" or tType = "service_tv_episode"
        favType = "episode"
    end if
    if favType = "" and item.hasField("showName") and safeStr(item.showName) <> "" then favType = "show"
    if favType = "" and item.hasField("showTitle") and safeStr(item.showTitle) <> "" then favType = "show"
    if favType = "" then favType = "movie"

    favImage = ""
    if item.hasField("HDPosterUrl") and item.HDPosterUrl <> invalid then favImage = safeStr(item.HDPosterUrl)
    if favImage = "" and item.hasField("posterUrl") and item.posterUrl <> invalid then favImage = safeStr(item.posterUrl)
    if favImage = "" and item.hasField("showPoster") and item.showPoster <> invalid then favImage = safeStr(item.showPoster)
    if favImage = "" and item.hasField("posterPath") and item.posterPath <> invalid then favImage = safeStr(item.posterPath)
    if favImage = "" and item.hasField("stillUrl") and item.stillUrl <> invalid then favImage = safeStr(item.stillUrl)

    showVal = ""
    if item.hasField("showName") and item.showName <> invalid then showVal = safeStr(item.showName)
    if showVal = "" and item.hasField("showTitle") and item.showTitle <> invalid then showVal = safeStr(item.showTitle)

    pathVal = ""
    if item.hasField("mediaPath") and item.mediaPath <> invalid then pathVal = safeStr(item.mediaPath)
    driveVal = ""
    if item.hasField("driveId") and item.driveId <> invalid then driveVal = safeStr(item.driveId)

    favItem = {
        title: favTitle,
        type: favType,
        image: favImage,
        show: showVal,
        path: pathVal,
        driveId: driveVal,
        targetType: tType
    }
    m.toggleFavTask = CreateAuthHttpTask()
    m.toggleFavTask.url = m.serverUrl + "/api/favorites/toggle"
    m.toggleFavTask.method = "POST"
    m.toggleFavTask.postData = FormatJson({ item: favItem })
    m.toggleFavTask.observeField("result", "onToggleFavResult")
    m.toggleFavTask.observeField("error", "onToggleFavResult")
    m.toggleFavTask.control = "run"
end sub

sub onToggleFavResult()
    if m.toggleFavTask = invalid or m.toggleFavTask.result = invalid or m.toggleFavTask.result = "" then return
    data = ParseJSON(m.toggleFavTask.result)
    if data = invalid then return

    isFav = false
    if data.isFavorite <> invalid then isFav = data.isFavorite

    if isFav
        showNotification("Favorites", "Added to favorites")
    else
        showNotification("Favorites", "Removed from favorites")
    end if

    ' Reload the Favorites list in place so a just-removed tile disappears.
    if m.activeSidebar = 3 or (m.folderBreadcrumb <> invalid and m.folderBreadcrumb.text <> invalid and Instr(1, m.folderBreadcrumb.text, "Favorites") > 0)
        refreshFavoritesGrid()
    end if
end sub

' ---- Play/Pause Favorite Toggle (Remote) ----

function getFocusedFavoriteItem() as Object
    if m.posterGrid <> invalid and m.posterGrid.hasFocus()
        idx = m.posterGrid.itemFocused
        if idx >= 0 and idx < m.gridItems.count()
            item = m.gridItems[idx]
            if isFavoriteItem(item) then return item
        end if
    end if
    if m.cwGrid <> invalid and m.cwGrid.hasFocus()
        idx = m.cwGrid.itemFocused
        if idx >= 0 and idx < m.cwItems.count()
            item = m.cwItems[idx]
            if isFavoriteItem(item) then return item
        end if
    end if
    return invalid
end function

function isFavoriteItem(item as Object) as Boolean
    if item = invalid return false
    t = safeStr(item.targetType)
    if t = "drive_movie" or t = "drive_episode" or t = "drive_show" or t = "drive_season" then return true
    if t = "fave_item" or t = "fave_show" then return true
    if t = "popular_item" or t = "torrent_item" or t = "popular_tv_season" then return true
    if t = "service_tv_item" or t = "service_movie_item" or t = "service_tv_season" or t = "service_tv_episode" then return true
    return false
end function

sub toggleFocusedFavorite()
    item = getFocusedFavoriteItem()
    if item = invalid then return
    toggleFavorite(item)
end sub

' ---- Notifications ----

sub showNotification(titleText as String, msgText as String)
    m.notifTitle.text = titleText
    m.notifMsg.text = msgText
    m.notifGroup.visible = true
    m.notifTimer.control = "stop"
    m.notifTimer.duration = 5
    m.notifTimer.control = "start"
end sub

sub onNotificationDismiss()
    m.notifGroup.visible = false
end sub

sub refreshFavoritesGrid()
    m.folderBreadcrumb.text = "Home > Favorites"
    m.favesTask = CreateAuthHttpTask()
    m.favesTask.url = m.serverUrl + "/api/favorites"
    m.favesTask.observeField("result", "onFavoritesResult")
    m.favesTask.observeField("error", "onFavoritesError")
    m.favesTask.control = "run"
end sub

sub openFaveShowSeasons(showName as String)
    m.folderBreadcrumb.text = "Loading " + showName + "..."
    m.faveShowName = showName
    m.faveShowTask = CreateAuthHttpTask()
    m.faveShowTask.url = m.serverUrl + "/api/ondemand"
    m.faveShowTask.observeField("result", "onFaveShowLibraryResult")
    m.faveShowTask.observeField("error", "onFaveShowLibraryError")
    m.faveShowTask.control = "run"
end sub

sub onFaveShowLibraryResult()
    if m.faveShowTask = invalid return
    result = m.faveShowTask.result
    if result = invalid or result = ""
        m.folderBreadcrumb.text = "Failed to load show"
        return
    end if
    data = ParseJSON(result)
    if data = invalid
        m.folderBreadcrumb.text = "Failed to load show"
        return
    end if
    if data.shows <> invalid then m.driveShows = data.shows
    if data.showsList <> invalid then m.driveShowsList = data.showsList

    showName = safeStr(m.faveShowName)
    seasons = invalid
    if m.driveShows <> invalid then seasons = m.driveShows[showName]
    if seasons = invalid or seasons.count() = 0
        m.folderBreadcrumb.text = "Show not found in your Drive library"
        return
    end if
    openDriveShowSeasons(showName, seasons, "Home > Favorites > ")
end sub

sub onFaveShowLibraryError()
    m.folderBreadcrumb.text = "Error loading show"
end sub

' ---- Playback Progress ----

sub submitPlaybackProgress(mediaPath as String, currentTime as Dynamic, duration as Dynamic, title as String, typeStr as String, showName as String, season as Dynamic, episode as Dynamic, posterPath as String)
    if not isLoggedIn() or mediaPath = "" then return
    cTime = safeInt(currentTime)
    if cTime < 0 then cTime = 0
    dTime = safeInt(duration)
    if dTime < 0 then dTime = 0
    progressData = {
        path: mediaPath
        currentTime: cTime
        duration: dTime
        title: safeStr(title)
        type: safeStr(typeStr)
        show: safeStr(showName)
        season: season
        episode: episode
        posterPath: safeStr(posterPath)
    }
    m.progressTask = CreateAuthHttpTask()
    m.progressTask.url = m.serverUrl + "/api/playback/progress"
    m.progressTask.method = "POST"
    m.progressTask.postData = FormatJson(progressData)
    m.progressTask.observeField("result", "onProgressResult")
    m.progressTask.observeField("error", "onProgressResult")
    m.progressTask.control = "run"
end sub

sub onProgressResult()
end sub

sub startProgressTimer()
    if m.progressTimer <> invalid
        m.progressTimer.control = "stop"
        m.top.removeChild(m.progressTimer)
        m.progressTimer = invalid
    end if
    m.progressTimer = CreateObject("roSGNode", "Timer")
    m.progressTimer.duration = 10
    m.progressTimer.observeField("fire", "onProgressTimerFire")
    m.top.appendChild(m.progressTimer)
    m.progressTimer.control = "start"
end sub

sub onProgressTimerFire()
    if m.state <> "player" or m.isLiveChannel then return
    vidPos = m.video.position
    if vidPos = invalid or vidPos < 5 then return
    vidDur = m.video.duration
    if vidDur = invalid then vidDur = 0
    if vidPos > vidDur * 0.95 then return

    startOffset = 0
    if m.initialPlayOffset <> invalid and m.initialPlayOffset > 0 then startOffset = m.initialPlayOffset
    effectivePos = startOffset + vidPos

    posterPath = ""
    title = m.currentStreamTitle
    typeStr = "video"
    showName = ""
    season = invalid
    episode = invalid
    mediaPath = ""
    if m.currentPlayFilePath <> invalid then mediaPath = m.currentPlayFilePath
    if m.currentPlayingItemType <> invalid then typeStr = m.currentPlayingItemType
    if m.currentPlayingShow <> invalid then showName = m.currentPlayingShow
    if m.currentPlayingSeason <> invalid then season = m.currentPlayingSeason
    if m.currentPlayingEpisode <> invalid then episode = m.currentPlayingEpisode
    if m.currentPlayingPoster <> invalid then posterPath = m.currentPlayingPoster

    submitPlaybackProgress(mediaPath, effectivePos, vidDur, title, typeStr, showName, season, episode, posterPath)

    ' If watching a chunked HLS stream and approaching the end of the current chunk,
    ' pre-warm the next chunk so chaining will be seamless with no buffering gap.
    if isChunkedHlsStream() and vidPos >= (chunkSeconds() - 90) and vidPos > 30
        startNextChunkWarm()
    end if
end sub

' ---- Sidebar Navigation Helpers ----

sub updateIpHighlight()
    if m.isIpFocused
        m.ipFrame.visible = true
        m.ipLabel.color = "#FFFFFF"
        m.ipContainer.color = "#2A2E3F"
    else
        m.ipFrame.visible = false
        m.ipLabel.color = "#A3A8B8"
        m.ipContainer.color = "#14161F"
    end if
end sub

sub pushCurrentState(newBreadcrumb as String)
    isChannelSection = (InStr(1, newBreadcrumb, "Free TV > ") > 0)
    if not isChannelSection
        stopBackgroundPlayback()
    end if
    m.navStack.push({
        breadcrumb: m.folderBreadcrumb.text,
        content: m.posterGrid.content,
        gridItems: m.gridItems,
        focusedIdx: m.posterGrid.itemFocused,
        basePosterSize: m.posterGrid.basePosterSize,
        itemSpacing: m.posterGrid.itemSpacing,
        numColumns: m.posterGrid.numColumns,
        numRows: m.posterGrid.numRows,
        translation: m.posterGrid.translation
    })
    m.folderBreadcrumb.text = newBreadcrumb
    m.savedGridBreadcrumb = newBreadcrumb
    m.posterGrid.translation = [20, 76]
    m.posterGrid.basePosterSize = [165, 270]
    m.posterGrid.itemSpacing = [20, 14]
    m.posterGrid.numColumns = 6
    m.posterGrid.numRows = 2
    m.posterGrid.visible = true
    m.heroGroup.visible = false
    m.cwLabel.visible = false
    m.cwGrid.visible = false
    
    if m.cwInfoBar <> invalid then m.cwInfoBar.visible = false
    if m.cwInfoTitle <> invalid then m.cwInfoTitle.visible = false
    if m.cwInfoDesc <> invalid then m.cwInfoDesc.visible = false
    if isChannelSection
        if m.homeOverlay <> invalid then m.homeOverlay.opacity = 0.65
    else
        if m.homeOverlay <> invalid then m.homeOverlay.opacity = 0.85
    end if
end sub

function popState() as Boolean
    if m.navStack.count() = 0 then return false
    if m.pairingPollTask <> invalid
        m.pairingPollTask.control = "stop"
        m.pairingPollTask = invalid
    end if
    if m.pairingGroup <> invalid then m.pairingGroup.visible = false
    closeGamePlayerScreen()
    prev = m.navStack.pop()
    isChannelSection = (InStr(1, prev.breadcrumb, "Free TV > ") > 0)
    if not isChannelSection
        stopBackgroundPlayback()
    end if
    m.folderBreadcrumb.text = prev.breadcrumb
    m.savedGridBreadcrumb = prev.breadcrumb
    m.gridItems = prev.gridItems
    if prev.basePosterSize <> invalid then m.posterGrid.basePosterSize = prev.basePosterSize
    if prev.itemSpacing <> invalid then m.posterGrid.itemSpacing = prev.itemSpacing
    if prev.numColumns <> invalid then m.posterGrid.numColumns = prev.numColumns
    if prev.numRows <> invalid then m.posterGrid.numRows = prev.numRows
    if prev.translation <> invalid then m.posterGrid.translation = prev.translation
    m.posterGrid.content = prev.content
    if prev.focusedIdx >= 0 and prev.focusedIdx < m.gridItems.count()
        m.posterGrid.jumpToItem = prev.focusedIdx
    end if
    if m.navStack.count() = 0
        m.heroGroup.visible = true
        m.posterGrid.visible = false
        if m.homeOverlay <> invalid then m.homeOverlay.opacity = 0.65
        updateContinueWatchingGrid()
        if m.cwItems.count() > 0
            m.cwGrid.setFocus(true)
        else
            m.posterGrid.setFocus(true)
        end if
    else
        m.posterGrid.setFocus(true)
    end if
    return true
end function

' ---- Streaming Services Section (Netflix, Prime, Disney, Paramount, etc.) ----

sub openServicesRootGrid()
    svcIdx = 2
    if isLoggedIn() then svcIdx = 4
    m.activeSidebar = svcIdx
    updateSidebarNav()
    pushCurrentState("Home > Services")
    m.folderBreadcrumb.text = "Loading Streaming Services..."

    m.servicesTask = CreateObject("roSGNode", "HttpTask")
    m.servicesTask.url = m.serverUrl + "/api/services"
    m.servicesTask.observeField("result", "onServicesResult")
    m.servicesTask.observeField("error", "onServicesError")
    m.servicesTask.control = "run"
end sub

sub onServicesResult()
    if m.servicesTask = invalid return
    result = m.servicesTask.result
    if result = invalid or result = ""
        m.folderBreadcrumb.text = "Failed to load Services"
        return
    end if
    data = ParseJSON(result)
    if data = invalid or data.services = invalid or data.services.count() = 0
        m.folderBreadcrumb.text = "No streaming services available"
        return
    end if

    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    for each svc in data.services
        sId = safeStr(svc.id)
        sName = safeStr(svc.name)
        skipIds = ["pluto", "roku", "tubi", "plex"]
        skipSvc = false
        for each sk in skipIds
            if InStr(1, LCase(sId), sk) > 0 or InStr(1, LCase(sName), sk) > 0
                skipSvc = true
                exit for
            end if
        end for
        if skipSvc then continue for

        node = gridContent.CreateChild("ContentNode")
        if sName = "" then sName = "Service"
        node.title = sName

        pUrl = "pkg:/images/" + sId + ".jpg"
        setPosterUrl(node, pUrl)

        node.shortDescriptionLine1 = "Streaming Catalog"
        if svc.description <> invalid and svc.description <> ""
            node.description = svc.description
        else
            node.description = "Browse latest movies and TV shows from " + sName
        end if

        node.addFields({
            targetType: "service_item",
            serviceId: sId,
            serviceName: sName,
            servicePoster: pUrl
        })
        m.gridItems.push(node)
    end for

    m.folderBreadcrumb.text = "Home > Services (" + Stri(m.gridItems.count()).trim() + " Services)"
    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub onServicesError()
    m.folderBreadcrumb.text = "Error loading streaming services from server"
end sub

sub openServiceCatalogGrid(serviceId as String, serviceName as String, servicePoster as String)
    pushCurrentState("Home > Services > " + serviceName)
    m.folderBreadcrumb.text = "Loading " + serviceName + " Catalog..."

    m.currentServiceId = serviceId
    m.currentServiceName = serviceName
    m.currentServicePoster = servicePoster

    m.serviceCatalogTask = CreateObject("roSGNode", "HttpTask")
    m.serviceCatalogTask.url = m.serverUrl + "/api/services/" + serviceId
    m.serviceCatalogTask.observeField("result", "onServiceCatalogResult")
    m.serviceCatalogTask.observeField("error", "onServiceCatalogError")
    m.serviceCatalogTask.control = "run"
end sub

sub onServiceCatalogResult()
    if m.serviceCatalogTask = invalid return
    result = m.serviceCatalogTask.result
    if result = invalid or result = ""
        m.folderBreadcrumb.text = "Failed to load catalog for " + m.currentServiceName
        return
    end if
    data = ParseJSON(result)
    if data = invalid or data.items = invalid or data.items.count() = 0
        m.folderBreadcrumb.text = "No titles found for " + m.currentServiceName
        return
    end if

    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []
    totalCount = 0

    for each item in data.items
        node = gridContent.CreateChild("ContentNode")
        title = safeStr(item.title)
        if title = "" then title = "Untitled"
        node.title = title

        tType = safeStr(item.type)
        if tType = "" then tType = "movie"

        yearStr = ""
        yStr = safeStr(item.year)
        if yStr <> "" and yStr <> "0" then yearStr = " (" + yStr + ")"

        typeLabel = "Movie"
        if tType = "tv" then typeLabel = "TV Series"
        node.shortDescriptionLine1 = typeLabel + yearStr

        desc = safeStr(item.description)
        if desc = "" then desc = title + " on " + m.currentServiceName
        node.description = desc

        imgUrl = safeStr(item.image)
        fallbackUrl = m.serverUrl + "/api/poster/card?name=" + encodePath(title)
        pUrl = resolvePosterUrl(imgUrl, fallbackUrl)
        setPosterUrl(node, pUrl)

        if tType = "tv"
            node.addFields({
                targetType: "service_tv_item",
                itemTitle: title,
                itemType: "tv",
                serviceName: m.currentServiceName,
                posterUrl: pUrl
            })
        else
            node.addFields({
                targetType: "service_movie_item",
                itemTitle: title,
                itemType: "movie",
                serviceName: m.currentServiceName,
                posterUrl: pUrl
            })
        end if

        m.gridItems.push(node)
        totalCount = totalCount + 1
    end for

    m.folderBreadcrumb.text = "Home > Services > " + m.currentServiceName + " (" + Stri(totalCount).trim() + " Titles)"
    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub onServiceCatalogError()
    m.folderBreadcrumb.text = "Error loading catalog for " + m.currentServiceName
end sub

sub openServiceTvSeasonsGrid(showTitle as String, showPoster as String)
    pushCurrentState("Home > Services > " + showTitle)
    m.folderBreadcrumb.text = "Loading seasons for " + showTitle + "..."

    m.currentTvShowTitle = showTitle
    m.currentTvShowPoster = showPoster

    m.tvDetailsTask = CreateObject("roSGNode", "HttpTask")
    m.tvDetailsTask.url = m.serverUrl + "/api/services/tv-details?title=" + encodePath(showTitle)
    m.tvDetailsTask.observeField("result", "onServiceTvDetailsResult")
    m.tvDetailsTask.observeField("error", "onServiceTvDetailsError")
    m.tvDetailsTask.control = "run"
end sub

sub onServiceTvDetailsResult()
    if m.tvDetailsTask = invalid return
    result = m.tvDetailsTask.result
    if result = invalid or result = ""
        m.folderBreadcrumb.text = "Failed to load seasons for " + m.currentTvShowTitle
        return
    end if
    data = ParseJSON(result)
    if data = invalid or data.seasons = invalid or data.seasons.count() = 0
        m.folderBreadcrumb.text = "No seasons found for " + m.currentTvShowTitle
        return
    end if

    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []
    showPoster = m.currentTvShowPoster
    if data.poster <> invalid and data.poster <> ""
        showPoster = data.poster
    end if

    ' Sort seasons numerically ascending
    sCount = data.seasons.count()
    if sCount > 1
        for i = 0 to sCount - 2
            for j = 0 to sCount - i - 2
                sA = safeInt(data.seasons[j].seasonNumber)
                sB = safeInt(data.seasons[j + 1].seasonNumber)
                if sA > sB
                    tmp = data.seasons[j]
                    data.seasons[j] = data.seasons[j + 1]
                    data.seasons[j + 1] = tmp
                end if
            end for
        end for
    end if

    ' Find latest episode across all seasons
    latestSeasonNum = -1
    latestEpNum = -1
    latestEpObj = invalid
    for each s in data.seasons
        sNum = safeInt(s.seasonNumber)
        if sNum > 0 and s.episodes <> invalid
            for each ep in s.episodes
                eNum = safeInt(ep.episodeNumber)
                if sNum > latestSeasonNum or (sNum = latestSeasonNum and eNum > latestEpNum)
                    latestSeasonNum = sNum
                    latestEpNum = eNum
                    latestEpObj = ep
                end if
            end for
        end if
    end for

    ' Prepend "★ Latest Episode" card if found
    if latestEpObj <> invalid and latestSeasonNum > 0 and latestEpNum > 0
        sNumStr = Stri(latestSeasonNum).trim()
        eNumStr = Right(Stri(100 + latestEpNum).trim(), 2)
        epName = safeStr(latestEpObj.name)
        if epName = "" then epName = "Episode " + Stri(latestEpNum).trim()
        fullTitle = "S" + sNumStr + "E" + eNumStr + " - " + epName

        lCard = gridContent.CreateChild("ContentNode")
        lCard.title = "★ Latest: " + fullTitle
        setPosterUrl(lCard, "pkg:/images/star.jpg")
        lCard.shortDescriptionLine1 = "Quick Play · Latest Episode"
        lCard.description = m.currentTvShowTitle + " " + fullTitle
        lCard.addFields({
            targetType: "service_tv_episode",
            showTitle: m.currentTvShowTitle,
            seasonNum: sNumStr,
            episodeNum: Stri(latestEpNum).trim(),
            episodeName: epName,
            fullTitle: fullTitle,
            itemTitle: m.currentTvShowTitle + " S" + sNumStr + "E" + eNumStr,
            searchQuery: m.currentTvShowTitle + " S" + sNumStr + "E" + eNumStr
        })
        m.gridItems.push(lCard)
    end if

    for each s in data.seasons
        node = gridContent.CreateChild("ContentNode")
        sNum = 1
        if s.seasonNumber <> invalid then sNum = s.seasonNumber
        sName = "Season " + Stri(sNum).trim()
        if s.name <> invalid and s.name <> "" then sName = s.name
        node.title = sName

        setPosterUrl(node, showPoster)

        epCount = 0
        if s.episodes <> invalid then epCount = s.episodes.count()
        node.shortDescriptionLine1 = Stri(epCount).trim() + " Episodes"
        node.description = m.currentTvShowTitle + " - " + sName + " (" + Stri(epCount).trim() + " episodes)"

        node.addFields({
            targetType: "service_tv_season",
            showTitle: m.currentTvShowTitle,
            seasonNum: Stri(sNum).trim(),
            seasonName: sName,
            episodes: s.episodes,
            showPoster: showPoster
        })
        m.gridItems.push(node)
    end for

    m.folderBreadcrumb.text = "Home > " + m.currentTvShowTitle + " (" + Stri(data.seasons.count()).trim() + " Seasons)"
    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub onServiceTvDetailsError()
    m.folderBreadcrumb.text = "Error fetching seasons for " + m.currentTvShowTitle
end sub

sub openServiceTvEpisodesGrid(showTitle as String, seasonNum as String, seasonName as String, episodes as Object, showPoster as String)
    if episodes = invalid or episodes.count() = 0 return
    pushCurrentState("Home > " + showTitle + " > " + seasonName)
    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    ' Sort episodes numerically ascending
    sortedEps = []
    for each ep in episodes
        sortedEps.push(ep)
    end for
    epCount = sortedEps.count()
    if epCount > 1
        for i = 0 to epCount - 2
            for j = 0 to epCount - i - 2
                eA = safeInt(sortedEps[j].episodeNumber)
                eB = safeInt(sortedEps[j + 1].episodeNumber)
                if eA > eB
                    tmp = sortedEps[j]
                    sortedEps[j] = sortedEps[j + 1]
                    sortedEps[j + 1] = tmp
                end if
            end for
        end for
    end if

    for each ep in sortedEps
        node = gridContent.CreateChild("ContentNode")
        eNum = 1
        if ep.episodeNumber <> invalid then eNum = ep.episodeNumber
        eNumStr = Right(Stri(100 + eNum).trim(), 2)

        epName = safeStr(ep.name)
        if epName = "" then epName = "Episode " + Stri(eNum).trim()

        fullTitle = "S" + seasonNum + "E" + eNumStr + " - " + epName
        node.title = fullTitle

        pUrl = showPoster
        if ep.stillUrl <> invalid and ep.stillUrl <> ""
            pUrl = ep.stillUrl
        end if
        setPosterUrl(node, pUrl)

        rTime = ""
        if ep.runtime <> invalid and ep.runtime > 0
            rTime = Stri(ep.runtime).trim() + " mins"
        else if ep.airdate <> invalid and ep.airdate <> ""
            rTime = ep.airdate
        else
            rTime = "Episode " + Stri(eNum).trim()
        end if
        node.shortDescriptionLine1 = rTime

        overview = safeStr(ep.overview)
        if overview = "" then overview = showTitle + " " + fullTitle
        node.description = overview

        node.addFields({
            targetType: "service_tv_episode",
            showTitle: showTitle,
            seasonNum: seasonNum,
            episodeNum: Stri(eNum).trim(),
            episodeName: epName,
            fullTitle: fullTitle,
            itemTitle: showTitle + " S" + seasonNum + "E" + eNumStr,
            searchQuery: showTitle + " S" + seasonNum + "E" + eNumStr
        })
        m.gridItems.push(node)
    end for

    m.folderBreadcrumb.text = "Home > " + showTitle + " > " + seasonName + " (" + Stri(sortedEps.count()).trim() + " Episodes)"
    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub handleMovieLaunch(item as Object)
    searchPopularTorrent(item)
end sub

sub handleEpisodeLaunch(item as Object)
    q = ""
    if item.searchQuery <> invalid and item.searchQuery <> ""
        q = item.searchQuery
    else if item.itemTitle <> invalid and item.itemTitle <> ""
        q = item.itemTitle
    else if item.title <> invalid
        q = item.title
    end if

    searchQueryTorrent(q, item)
end sub

sub searchQueryTorrent(searchQuery as String, item as Object)
    if m.state = "grid" and m.folderBreadcrumb <> invalid and m.folderBreadcrumb.text <> invalid
        if Left(m.folderBreadcrumb.text, 10) <> "Searching " and Left(m.folderBreadcrumb.text, 13) <> "Initializing "
            m.savedGridBreadcrumb = m.folderBreadcrumb.text
        end if
    end if
    m.currentPopularItem = item
    m.folderBreadcrumb.text = "Searching torrents for " + searchQuery + "..."

    m.episodeSearchTask = CreateObject("roSGNode", "HttpTask")
    m.episodeSearchTask.url = m.serverUrl + "/api/torrent-search?q=" + encodePath(searchQuery) + "&type=tv"
    m.episodeSearchTask.observeField("result", "onEpisodeTorrentResult")
    m.episodeSearchTask.observeField("error", "onEpisodeTorrentError")
    m.episodeSearchTask.control = "run"
end sub

sub onEpisodeTorrentResult()
    if m.episodeSearchTask = invalid return
    result = m.episodeSearchTask.result
    if result = invalid or result = ""
        promptPopularNoTorrents()
        return
    end if
    data = ParseJSON(result)
    if data = invalid or data.results = invalid or data.results.count() = 0
        promptPopularNoTorrents()
        return
    end if

    best = invalid
    bestScore = 999999999
    for each r in data.results
        score = torrentScore(r)
        if score < bestScore
            bestScore = score
            best = r
        end if
    end for

    if best = invalid or best.link = invalid or best.link = ""
        promptPopularNoTorrents()
        return
    end if

    playTorrentStream(best.link, best.title)
end sub

sub onEpisodeTorrentError()
    promptPopularNoTorrents()
end sub

sub searchPopularTorrent(item as Object)
    if m.state = "grid" and m.folderBreadcrumb <> invalid and m.folderBreadcrumb.text <> invalid
        if Left(m.folderBreadcrumb.text, 10) <> "Searching " and Left(m.folderBreadcrumb.text, 13) <> "Initializing "
            m.savedGridBreadcrumb = m.folderBreadcrumb.text
        end if
    end if
    title = ""
    if item.itemTitle <> invalid then title = item.itemTitle.toStr()
    if title = "" and item.title <> invalid then title = item.title.toStr()
    tType = "movie"
    if item.itemType <> invalid then tType = item.itemType.toStr()

    m.currentPopularItem = item
    m.folderBreadcrumb.text = "Searching torrents for " + title + "..."

    m.popularSearchTask = CreateObject("roSGNode", "HttpTask")
    m.popularSearchTask.url = m.serverUrl + "/api/torrent-search?q=" + encodePath(title) + "&type=" + tType
    m.popularSearchTask.observeField("result", "onPopularTorrentResult")
    m.popularSearchTask.observeField("error", "onPopularTorrentError")
    m.popularSearchTask.control = "run"
end sub

sub onPopularTorrentResult()
    if m.popularSearchTask = invalid return
    result = m.popularSearchTask.result
    if result = invalid or result = ""
        promptPopularNoTorrents()
        return
    end if
    data = ParseJSON(result)
    if data = invalid or data.results = invalid or data.results.count() = 0
        promptPopularNoTorrents()
        return
    end if

    isTv = false
    if m.currentPopularItem <> invalid and m.currentPopularItem.itemType <> invalid
        if m.currentPopularItem.itemType.toStr() = "tv" then isTv = true
    end if

    if isTv
        showPopularTvSeasonsGrid(data.results)
        return
    end if

    best = invalid
    bestScore = 999999999
    for each r in data.results
        score = torrentScore(r)
        if score < bestScore
            bestScore = score
            best = r
        end if
    end for

    if best = invalid or best.link = invalid or best.link = ""
        promptPopularNoTorrents()
        return
    end if

    playTorrentStream(best.link, best.title)
end sub

sub showPopularTvSeasonsGrid(results as Object)
    showTitle = ""
    if m.currentPopularItem <> invalid and m.currentPopularItem.itemTitle <> invalid then showTitle = m.currentPopularItem.itemTitle.toStr()
    if showTitle = "" and m.currentPopularItem <> invalid and m.currentPopularItem.title <> invalid then showTitle = m.currentPopularItem.title.toStr()

    seasonsMap = {}
    seasonsList = []
    latestTorrent = invalid
    latestSeason = -1
    latestEpisode = -1

    for each r in results
        tTitle = safeStr(r.title)
        ' Filter out COMPLETE or season batch torrents
        if isCompleteTorrentBatch(tTitle) then continue for

        epInfo = parseSeasonEpisode(tTitle)
        ' Must have an episode number to be an individual episode torrent
        if epInfo.episode <= 0 then continue for

        sNum = epInfo.season
        if sNum <= 0 then sNum = 1
        sKey = Stri(sNum).trim()

        if seasonsMap[sKey] = invalid
            seasonsMap[sKey] = []
            seasonsList.push(sNum)
        end if
        seasonsMap[sKey].push(r)

        ' Track latest episode across all seasons
        if sNum > latestSeason or (sNum = latestSeason and epInfo.episode > latestEpisode)
            latestSeason = sNum
            latestEpisode = epInfo.episode
            latestTorrent = r
        else if sNum = latestSeason and epInfo.episode = latestEpisode
            if latestTorrent = invalid or torrentScore(r) < torrentScore(latestTorrent)
                latestTorrent = r
            end if
        end if
    end for

    if seasonsList.count() = 0
        promptPopularNoTorrents()
        return
    end if

    seasonsList.sort()

    pushCurrentState("Home > Fresh > " + showTitle)
    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    showPoster = "pkg:/images/no-poster.jpg"
    if m.currentPopularItem <> invalid and m.currentPopularItem.HDPosterUrl <> invalid
        showPoster = m.currentPopularItem.HDPosterUrl
    end if

    ' Prepend "★ Latest Episode" card if found
    if latestTorrent <> invalid and latestSeason > 0 and latestEpisode > 0
        lNode = gridContent.CreateChild("ContentNode")
        sStr = Right(Stri(100 + latestSeason).trim(), 2)
        eStr = Right(Stri(100 + latestEpisode).trim(), 2)
        lNode.title = "★ Latest: S" + sStr + "E" + eStr
        setPosterUrl(lNode, "pkg:/images/star.jpg")
        seeds = safeInt(latestTorrent.seeds)
        qStr = safeStr(latestTorrent.quality)
        meta = "Quick Play · Latest Episode"
        if qStr <> "" then meta = meta + " · " + qStr
        meta = meta + " · " + Stri(seeds).trim() + " seeds"
        lNode.shortDescriptionLine1 = meta
        lNode.description = "Play latest episode: " + safeStr(latestTorrent.title)
        tLink = safeStr(latestTorrent.link)
        if tLink = "" and latestTorrent.magnet <> invalid then tLink = safeStr(latestTorrent.magnet)
        lNode.addFields({ targetType: "torrent_item", link: tLink, itemTitle: safeStr(latestTorrent.title) })
        m.gridItems.push(lNode)
    end if

    for each sNum in seasonsList
        sKey = Stri(sNum).trim()
        tList = seasonsMap[sKey]
        node = gridContent.CreateChild("ContentNode")
        node.title = "Season " + sKey
        setPosterUrl(node, showPoster)
        node.shortDescriptionLine1 = Stri(tList.count()).trim() + " Episodes"
        node.description = showTitle + " - Season " + sKey + " (" + Stri(tList.count()).trim() + " episode torrents)"
        node.addFields({ targetType: "popular_tv_season", showTitle: showTitle, seasonNum: sKey, torrents: tList, showPoster: showPoster })
        m.gridItems.push(node)
    end for

    m.folderBreadcrumb.text = "Home > Fresh > " + showTitle + " (" + Stri(seasonsList.count()).trim() + " Seasons)"
    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub openPopularTvSeasonTorrentsGrid(showTitle as String, seasonNum as String, torrents as Object)
    pushCurrentState("Home > Fresh > " + showTitle + " > Season " + seasonNum)
    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    showPoster = "pkg:/images/no-poster.jpg"
    if m.currentPopularItem <> invalid and m.currentPopularItem.HDPosterUrl <> invalid
        showPoster = m.currentPopularItem.HDPosterUrl
    end if

    filteredTorrents = []
    latestTorrent = invalid
    latestEpisode = -1

    for each t in torrents
        tTitle = safeStr(t.title)
        if isCompleteTorrentBatch(tTitle) then continue for
        epInfo = parseSeasonEpisode(tTitle)
        if epInfo.episode <= 0 then continue for

        filteredTorrents.push(t)

        if epInfo.episode > latestEpisode
            latestEpisode = epInfo.episode
            latestTorrent = t
        else if epInfo.episode = latestEpisode
            if latestTorrent = invalid or torrentScore(t) < torrentScore(latestTorrent)
                latestTorrent = t
            end if
        end if
    end for

    ' Fallback to raw list if strict filter had no matches
    if filteredTorrents.count() = 0
        for each t in torrents
            filteredTorrents.push(t)
        end for
    end if

    ' Sort torrents by Episode ascending, then by seeders/quality
    sortTvTorrentsByEpisode(filteredTorrents)

    ' If multiple episodes exist in this season, prepend a "★ Latest Episode" card
    if latestTorrent <> invalid and latestEpisode > 0 and filteredTorrents.count() > 1
        lNode = gridContent.CreateChild("ContentNode")
        eStr = Right(Stri(100 + latestEpisode).trim(), 2)
        sStr = Right(Stri(100 + safeInt(seasonNum)).trim(), 2)
        lNode.title = "★ Latest: S" + sStr + "E" + eStr
        setPosterUrl(lNode, "pkg:/images/star.jpg")
        seeds = safeInt(latestTorrent.seeds)
        qStr = safeStr(latestTorrent.quality)
        meta = "Quick Play · Latest Episode"
        if qStr <> "" then meta = meta + " · " + qStr
        meta = meta + " · " + Stri(seeds).trim() + " seeds"
        lNode.shortDescriptionLine1 = meta
        lNode.description = "Play latest episode: " + safeStr(latestTorrent.title)
        tLink = safeStr(latestTorrent.link)
        if tLink = "" and latestTorrent.magnet <> invalid then tLink = safeStr(latestTorrent.magnet)
        lNode.addFields({ targetType: "torrent_item", link: tLink, itemTitle: safeStr(latestTorrent.title) })
        m.gridItems.push(lNode)
    end if

    for each t in filteredTorrents
        node = gridContent.CreateChild("ContentNode")
        tTitle = safeStr(t.title)
        if tTitle = "" then tTitle = "Torrent"

        epInfo = parseSeasonEpisode(tTitle)
        if epInfo.episode > 0
            eStr = Right(Stri(100 + epInfo.episode).trim(), 2)
            sStr = Right(Stri(100 + safeInt(seasonNum)).trim(), 2)
            node.title = "S" + sStr + "E" + eStr + " · " + tTitle
        else
            node.title = tTitle
        end if

        setPosterUrl(node, showPoster)
        seeds = safeInt(t.seeds)
        peers = safeInt(t.peers)
        qStr = safeStr(t.quality)
        meta = ""
        if qStr <> "" then meta = qStr + " · "
        meta = meta + Stri(seeds).trim() + " seeds, " + Stri(peers).trim() + " peers"
        node.shortDescriptionLine1 = meta
        node.description = tTitle
        tLink = safeStr(t.link)
        if tLink = "" and t.magnet <> invalid then tLink = safeStr(t.magnet)
        node.addFields({ targetType: "torrent_item", link: tLink, itemTitle: tTitle })
        m.gridItems.push(node)
    end for

    m.folderBreadcrumb.text = "Home > Fresh > " + showTitle + " > S" + seasonNum + " (" + Stri(filteredTorrents.count()).trim() + " Episodes)"
    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

function getSeasonFromTorrent(r as Object) as Integer
    if r = invalid return 1
    if r.season <> invalid and safeInt(r.season) > 0 return safeInt(r.season)
    info = parseSeasonEpisode(safeStr(r.title))
    if info.season > 0 return info.season
    return 1
end function

sub onPopularTorrentError()
    promptPopularNoTorrents()
end sub

sub promptPopularNoTorrents()
    item = m.currentPopularItem
    title = ""
    if item <> invalid
        if item.hasField("itemTitle") and item.itemTitle <> invalid then title = item.itemTitle.toStr()
        if title = "" and item.title <> invalid then title = item.title.toStr()
    end if
    if title = "" then title = "Item"

    m.folderBreadcrumb.text = "No torrents found for " + title

    dialog = CreateObject("roSGNode", "Dialog")
    if dialog <> invalid
        dialog.title = "No Torrents Found"
        dialog.message = ["No torrents were found for " + title + "."]
        dialog.buttons = ["OK"]
        dialog.observeField("buttonSelected", "onPopularNoTorrentsButton")
        m.top.dialog = dialog
    end if
end sub

sub onPopularNoTorrentsButton()
    dialog = m.top.dialog
    if dialog = invalid return
    dialog.close = true
    if m.posterGrid <> invalid then m.posterGrid.setFocus(true)
end sub

' ---- Free TV Grid ----

sub openFreeTvGrid()
    ftvIdx = 3
    if isLoggedIn() then ftvIdx = 5
    m.activeSidebar = ftvIdx
    updateSidebarNav()
    pushCurrentState("Home > Free TV")
    m.folderBreadcrumb.text = "Loading Free TV..."

    m.freeTvTask = CreateObject("roSGNode", "HttpTask")
    m.freeTvTask.url = m.serverUrl + "/api/freetv/channels"
    m.freeTvTask.observeField("result", "onFreeTvFetchResult")
    m.freeTvTask.observeField("error", "onFreeTvFetchError")
    m.freeTvTask.control = "run"
end sub

sub onFreeTvFetchResult()
    if m.freeTvTask = invalid return
    result = m.freeTvTask.result
    if result = invalid or result = ""
        m.folderBreadcrumb.text = "Failed to load Free TV channels"
        return
    end if

    data = ParseJSON(result)
    if data = invalid or data.channels = invalid
        m.folderBreadcrumb.text = "Invalid Free TV response"
        return
    end if

    m.allFreeTvChannels = data.channels
    rokuCount = 0
    plutoCount = 0
    tubiCount = 0
    plexCount = 0

    for each ch in data.channels
        p = ""
        if ch.provider <> invalid then p = LCase(ch.provider)
        if InStr(1, p, "roku") > 0
            rokuCount = rokuCount + 1
        else if InStr(1, p, "pluto") > 0
            plutoCount = plutoCount + 1
        else if InStr(1, p, "tubi") > 0
            tubiCount = tubiCount + 1
        else if InStr(1, p, "plex") > 0
            plexCount = plexCount + 1
        end if
    end for

    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    providers = []
    if rokuCount > 0
        providers.push({ id: "Roku Channel", title: "Roku Channel", count: rokuCount, img: "pkg:/images/roku.jpg", desc: "Live streaming FAST channels from The Roku Channel" })
    end if
    if plutoCount > 0
        providers.push({ id: "Pluto TV", title: "Pluto TV", count: plutoCount, img: "pkg:/images/pluto.jpg", desc: "Live streaming FAST channels from Pluto TV" })
    end if
    if tubiCount > 0
        providers.push({ id: "Tubi", title: "Tubi TV", count: tubiCount, img: "pkg:/images/tubi.jpg", desc: "Live streaming FAST channels from Tubi" })
    end if

    for each prov in providers
        node = CreateObject("roSGNode", "ContentNode")
        node.title = prov.title
        setPosterUrl(node, prov.img)
        node.shortDescriptionLine1 = Stri(prov.count).trim() + " Channels"
        node.description = prov.desc
        node.addFields({ targetType: "freetv_provider", providerName: prov.id, itemTitle: prov.title })
        gridContent.appendChild(node)
        m.gridItems.push(node)
    end for

    m.folderBreadcrumb.text = "Home > Free TV (Select Provider)"
    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
end sub

sub openFreeTvProviderGrid(providerName as String)
    if m.allFreeTvChannels = invalid or m.allFreeTvChannels.count() = 0
        openFreeTvGrid()
        return
    end if

    pushCurrentState("Home > Free TV > " + providerName)
    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    for each ch in m.allFreeTvChannels
        isMatch = false
        p = ""
        if ch.provider <> invalid then p = LCase(ch.provider)
        if providerName = "All"
            isMatch = true
        else if providerName = "Roku Channel" and InStr(1, p, "roku") > 0
            isMatch = true
        else if providerName = "Pluto TV" and InStr(1, p, "pluto") > 0
            isMatch = true
        else if providerName = "Tubi" and InStr(1, p, "tubi") > 0
            isMatch = true
        else if providerName = "Plex TV" and InStr(1, p, "plex") > 0
            isMatch = true
        end if

        if isMatch
            chId = "freetv_" + ch.plutoId
            if ch.id <> invalid and ch.id <> "" then chId = ch.id

            node = CreateObject("roSGNode", "ContentNode")
            node.title = ch.name

            posterUrl = "pkg:/images/no-poster.jpg"
            if ch.logo <> invalid and ch.logo <> ""
                posterUrl = ch.logo
            else if ch.featuredImage <> invalid and ch.featuredImage <> ""
                posterUrl = ch.featuredImage
            end if
            setPosterUrl(node, posterUrl)

            nowTitle = ""
            if ch.currentProgram <> invalid and ch.currentProgram.title <> invalid
                nowTitle = ch.currentProgram.title
                node.shortDescriptionLine1 = "Now: " + nowTitle
            else
                node.shortDescriptionLine1 = ch.category
            end if

            desc = ch.summary
            if ch.currentProgram <> invalid and ch.currentProgram.description <> invalid and ch.currentProgram.description <> ""
                desc = ch.currentProgram.description
            end if
            streamKey = ch.plutoId
            if streamKey = invalid or streamKey = ""
                streamKey = chId
                if Left(streamKey, 7) = "freetv_" then streamKey = Mid(streamKey, 8)
            end if
            stream = m.serverUrl + "/api/freetv/stream/" + streamKey + ".m3u8"
            if ch.streamUrl <> invalid and ch.streamUrl <> ""
                if Left(ch.streamUrl, 4) = "http"
                    stream = ch.streamUrl
                else
                    stream = m.serverUrl + ch.streamUrl
                end if
            end if

            node.addFields({ targetType: "freetv_channel", channelId: chId, streamUrl: stream, itemTitle: ch.name })
            gridContent.appendChild(node)
            m.gridItems.push(node)
        end if
    end for

    m.folderBreadcrumb.text = "Home > Free TV > " + providerName + " (" + Stri(m.gridItems.count()).trim() + " Channels)"
    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub onFreeTvFetchError()
    m.folderBreadcrumb.text = "Error fetching Free TV channels from server"
end sub

sub stopBackgroundPlayback()
    m.bgTunedChannelId = ""
    m.bgTunedTitle = ""
    if m.state = "grid" and m.video <> invalid
        m.video.control = "stop"
        m.video.visible = false
        if m.homeBg <> invalid then m.homeBg.visible = true
    end if
    m.isLiveChannel = false
end sub

' Tell the torrent streamer and cloud transcoder to stop the current torrent stream.
sub stopActiveTorrentStream()
    url = safeStr(m.currentStreamUrl)
    if url = "" then return

    streamId = ""
    isTorrentHls = false

    segPos = Instr(1, url, "/api/torrent/serve/")
    if segPos > 0
        after = Mid(url, segPos + Len("/api/torrent/serve/"))
        segEnd = Instr(1, after, "/")
        if segEnd > 0 then streamId = Left(after, segEnd - 1)
    else
        segPos = Instr(1, url, "/api/stream/torrent-hls/")
        if segPos > 0
            isTorrentHls = true
            after = Mid(url, segPos + Len("/api/stream/torrent-hls/"))
            segEnd = Instr(1, after, "/")
            if segEnd > 0 then streamId = Left(after, segEnd - 1)
        end if
    end if

    if streamId = "" then return

    ' 1. If cloud server was transcoding HLS for this torrent, stop FFmpeg on cloud server
    if isTorrentHls
        cloudStopTask = CreateObject("roSGNode", "HttpTask")
        cloudStopTask.url = m.serverUrl + "/api/stream/torrent-hls/stop"
        cloudStopTask.method = "POST"
        cloudStopTask.postData = FormatJson({ streamId: streamId })
        if isLoggedIn() then cloudStopTask.authToken = m.authToken
        cloudStopTask.control = "run"
    end if

    ' 2. Tell the dedicated torrent streamer to stop and clear the torrent from memory/cache
    task = CreateObject("roSGNode", "HttpTask")
    task.url = m.torrentServerUrl + "/api/torrent/stream/" + streamId + "/stop"
    task.method = "POST"
    task.control = "run"
end sub

' Ask the cloud server to kill the Drive HLS transcode for the current file.
' Called when the user exits a video or playback ends, so ffmpeg stops instead
' of transcoding the whole file in the background (frees the transcode cap).
sub stopDriveTranscode()
    url = safeStr(m.currentStreamUrl)
    if url = "" return
    segPos = Instr(1, LCase(url), "/api/stream/drive-hls/")
    if segPos <= 0 return
    after = Mid(url, segPos + Len("/api/stream/drive-hls/"))
    qPos = Instr(1, after, "?")
    if qPos > 0 then after = Left(after, qPos - 1)
    if Len(after) >= 5 and LCase(Right(after, 5)) = ".m3u8"
        after = Left(after, Len(after) - 5)
    end if
    fileId = ""
    if after <> invalid then fileId = after.trim()
    if fileId = "" return
    m.stopDriveTask = CreateObject("roSGNode", "HttpTask")
    m.stopDriveTask.url = m.serverUrl + "/api/stream/drive-hls/stop"
    m.stopDriveTask.method = "POST"
    m.stopDriveTask.postData = FormatJson({ fileId: fileId })
    if isLoggedIn() then m.stopDriveTask.authToken = m.authToken
    m.stopDriveTask.control = "run"
end sub

sub stopAllActiveStreams()
    stopBufferingWatchdog()
    if m.torrentHlsWarmupTask <> invalid
        m.torrentHlsWarmupTask.control = "stop"
        m.torrentHlsWarmupTask = invalid
    end if
    stopActiveTorrentStream()
    stopDriveTranscode()
    m.currentStreamUrl = ""
end sub

sub onPosterFocused()
    focusedIdx = m.posterGrid.itemFocused
    if focusedIdx >= 0 and focusedIdx < m.gridItems.count()
        item = m.gridItems[focusedIdx]
        if m.detailTitle <> invalid and item.title <> invalid then m.detailTitle.text = item.title
        if m.detailDesc <> invalid and item.description <> invalid then m.detailDesc.text = item.description
        if m.heroTitle <> invalid and item.title <> invalid and item.title <> "" then m.heroTitle.text = item.title
        if m.heroDesc <> invalid and item.description <> invalid and item.description <> "" then m.heroDesc.text = item.description
        if m.heroMeta <> invalid and item.shortDescriptionLine1 <> invalid and item.shortDescriptionLine1 <> ""
            m.heroMeta.text = item.shortDescriptionLine1
        end if
        if m.homeBg <> invalid and item.HDPosterUrl <> invalid and item.HDPosterUrl <> ""
            m.homeBg.loadDisplayMode = "zoomToFill"
            m.homeBg.uri = item.HDPosterUrl
        end if
        if m.cwInfoBar <> invalid and item.targetType <> "section_header"
            m.cwInfoBar.visible = true
            m.cwInfoTitle.visible = true
            m.cwInfoDesc.visible = true
            if item.title <> invalid then m.cwInfoTitle.text = item.title
            if item.description <> invalid and item.description <> ""
                m.cwInfoDesc.text = item.description
            else
                m.cwInfoDesc.text = ""
            end if
        else if m.cwInfoBar <> invalid
            m.cwInfoBar.visible = false
            m.cwInfoTitle.visible = false
            m.cwInfoDesc.visible = false
        end if

        stopBackgroundPlayback()
    end if
end sub

sub onPosterSelected()
    if m.isIpFocused
        return
    end if

    selectedIdx = m.posterGrid.itemSelected
    if selectedIdx < 0 or selectedIdx >= m.gridItems.count() then return
    item = m.gridItems[selectedIdx]
    tType = item.targetType

    if tType = "section_header"
        ' section headers are not selectable
    else if tType = "service_item"
        sId = ""
        sName = "Service"
        sPoster = ""
        if item.hasField("serviceId") and item.serviceId <> invalid then sId = item.serviceId.toStr()
        if item.hasField("serviceName") and item.serviceName <> invalid then sName = item.serviceName.toStr()
        if item.hasField("servicePoster") and item.servicePoster <> invalid then sPoster = item.servicePoster.toStr()
        openServiceCatalogGrid(sId, sName, sPoster)
    else if tType = "service_movie_item"
        handleMovieLaunch(item)
    else if tType = "service_tv_item"
        sTitle = ""
        sPoster = "pkg:/images/no-poster.jpg"
        if item.hasField("itemTitle") and item.itemTitle <> invalid then sTitle = item.itemTitle.toStr()
        if item.hasField("posterUrl") and item.posterUrl <> invalid then sPoster = item.posterUrl.toStr()
        openServiceTvSeasonsGrid(sTitle, sPoster)
    else if tType = "service_tv_season"
        sTitle = ""
        sNum = "1"
        sName = "Season 1"
        sPoster = "pkg:/images/no-poster.jpg"
        eps = []
        if item.hasField("showTitle") and item.showTitle <> invalid then sTitle = item.showTitle.toStr()
        if item.hasField("seasonNum") and item.seasonNum <> invalid then sNum = item.seasonNum.toStr()
        if item.hasField("seasonName") and item.seasonName <> invalid then sName = item.seasonName.toStr()
        if item.hasField("showPoster") and item.showPoster <> invalid then sPoster = item.showPoster.toStr()
        if item.hasField("episodes") and item.episodes <> invalid then eps = item.episodes
        openServiceTvEpisodesGrid(sTitle, sNum, sName, eps, sPoster)
    else if tType = "service_tv_episode"
        handleEpisodeLaunch(item)
    else if tType = "popular_item"
        searchPopularTorrent(item)
    else if tType = "popular_tv_season"
        openPopularTvSeasonTorrentsGrid(item.showTitle, item.seasonNum, item.torrents)
    else if tType = "torrent_item"
        linkUrl = ""
        if item.link <> invalid then linkUrl = item.link.toStr()
        itemTitle = ""
        if item.itemTitle <> invalid then itemTitle = item.itemTitle.toStr()
        if itemTitle = "" and item.title <> invalid then itemTitle = item.title.toStr()
        playTorrentStream(linkUrl, itemTitle)
    else if tType = "freetv_provider"
        openFreeTvProviderGrid(item.providerName)
    else if tType = "freetv_channel"
m.currentPlayFilePath = ""
    m.currentPlayFilename = ""
        m.currentPlayingIndex = selectedIdx
        m.isLiveChannel = true
        m.isTvEpisode = false
        playFreeTvStream(item.streamUrl, safeStr(item.itemTitle))
    else if tType = "drive_tv_root"
        openDriveShowsGrid()
    else if tType = "drive_movies_root"
        openDriveMoviesGrid()
    else if tType = "drive_movie_folder"
        openDriveMovieFolderGrid(item.folderName, item.movies)
    else if tType = "drive_all_movies"
        openDriveAllMoviesGrid()
    else if tType = "drive_continue_watching"
        openDriveContinueWatching()
    else if tType = "drive_show"
        openDriveShowSeasons(item.showName, item.seasons)
    else if tType = "drive_season"
        cp = safeStr(item.crumbPrefix)
        if cp = "" then cp = "Home > Drive > "
        openDriveSeasonEpisodes(item.showName, item.seasonNum, item.episodes, cp)
    else if tType = "drive_episode"
        setDriveItemMeta(item)
        playDriveItem(item)
        prepareEpisodeAutoPlay(selectedIdx)
    else if tType = "drive_movie"
        setDriveItemMeta(item)
        playDriveItem(item)
    else if tType = "fave_show"
        showName = safeStr(item.showName)
        if showName = "" and item.hasField("itemTitle") and item.itemTitle <> invalid then showName = safeStr(item.itemTitle)
        if showName <> ""
            seasons = invalid
            if m.driveShows <> invalid then seasons = m.driveShows[showName]
            if seasons <> invalid and seasons.count() > 0
                openDriveShowSeasons(showName, seasons, "Home > Favorites > ")
            else
                ' If not in local Drive library, search popular cloud torrents
                searchPopularTorrent(item)
            end if
        end if
    else if tType = "fave_item"
        if (item.hasField("driveId") and safeStr(item.driveId) <> "") or (item.hasField("mediaPath") and safeStr(item.mediaPath) <> "")
            setDriveItemMeta(item)
            playDriveItem(item)
        else
            searchPopularTorrent(item)
        end if
    end if
end sub

sub setDriveItemMeta(item as Object)
    m.currentPlayingItemType = "video"
    m.currentPlayingShow = ""
    m.currentPlayingSeason = invalid
    m.currentPlayingEpisode = invalid
    m.currentPlayingPoster = ""

    if item.hasField("showName") and item.showName <> invalid
        m.currentPlayingShow = item.showName.toStr()
        m.currentPlayingItemType = "tv"
    end if
    if item.hasField("seasonNum") and item.seasonNum <> invalid
        m.currentPlayingSeason = item.seasonNum
    end if
    if item.hasField("episodeNum") and item.episodeNum <> invalid
        m.currentPlayingEpisode = item.episodeNum
    end if
    if item.hasField("posterUrl") and item.posterUrl <> invalid
        m.currentPlayingPoster = item.posterUrl.toStr()
    else if item.HDPosterUrl <> invalid
        m.currentPlayingPoster = item.HDPosterUrl
    end if
end sub

sub openDriveContinueWatching()
    if not isLoggedIn() then return
    pushCurrentState("Home > Drive > Continue Watching")
    m.folderBreadcrumb.text = "Loading continue watching..."

    m.driveCwTask = CreateAuthHttpTask()
    m.driveCwTask.url = m.serverUrl + "/api/ondemand"
    m.driveCwTask.observeField("result", "onDriveCwResult")
    m.driveCwTask.observeField("error", "onDriveCwError")
    m.driveCwTask.control = "run"
end sub

sub onDriveCwResult()
    if m.driveCwTask = invalid return
    result = m.driveCwTask.result
    if result = invalid or result = "" return
    data = ParseJSON(result)
    if data = invalid or data.continueWatching = invalid return

    m.driveAutoPlayNextEnabled = false
    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    for each item in data.continueWatching
        if item = invalid then continue for
        node = gridContent.CreateChild("ContentNode")
        title = safeStr(item.title)
        if title = "" then title = "Untitled"
        node.title = title
        posterUrl = safeStr(item.posterPath)
        if posterUrl = ""
            setPosterUrl(node, "pkg:/images/no-poster.jpg")
        else if LCase(posterUrl).left(4) = "http"
            setPosterUrl(node, posterUrl)
        else
            setPosterUrl(node, m.serverUrl + posterUrl)
        end if

        showName = safeStr(item.show)
        typeLabel = safeStr(item.type)
        epStr = ""
        if showName <> ""
            typeLabel = "TV"
            sNum = safeInt(item.season)
            eNum = safeInt(item.episode)
            if sNum > 0 and eNum > 0
                eNumStr = Right(Stri(100 + eNum).trim(), 2)
                epStr = " S" + Stri(sNum).trim() + "E" + eNumStr
            end if
        end if
        node.shortDescriptionLine1 = typeLabel + epStr

        pct = 0
        dur = safeInt(item.duration)
        cur = safeInt(item.currentTime)
        if dur > 0 then pct = Int((cur / dur) * 100)
        node.description = title + " (" + Stri(pct).trim() + "% watched)"

        node.addFields({
            targetType: "drive_episode"
            itemTitle: title
            mediaPath: safeStr(item.path)
            showName: showName
            seasonNum: item.season
            episodeNum: item.episode
            posterPath: safeStr(item.posterPath)
            currentTime: item.currentTime
            duration: item.duration
        })
        m.gridItems.push(node)
    end for

    m.folderBreadcrumb.text = "Home > Drive > Continue Watching (" + Stri(m.gridItems.count()).trim() + ")"
    m.posterGrid.content = gridContent
    m.posterGrid.setFocus(true)
    if m.gridItems.count() > 0
        m.posterGrid.jumpToItem = 0
        onPosterFocused()
    end if
end sub

sub onDriveCwError()
    m.folderBreadcrumb.text = "Error loading continue watching"
end sub

sub playTorrentStream(linkUrl as String, itemTitle as String)
    if linkUrl = "" or linkUrl = invalid return

    if m.state = "grid" and m.folderBreadcrumb <> invalid and m.folderBreadcrumb.text <> invalid
        if Left(m.folderBreadcrumb.text, 10) <> "Searching " and Left(m.folderBreadcrumb.text, 13) <> "Initializing "
            m.savedGridBreadcrumb = m.folderBreadcrumb.text
        end if
    end if

    m.currentPlayingItemType = "video"
    m.currentPlayingShow = ""
    m.currentPlayingSeason = invalid
    m.currentPlayingEpisode = invalid
    m.currentPlayingPoster = ""
    m.isTvEpisode = false
    m.currentEpisodeList = invalid
    m.currentEpisodeIndex = -1
    m.currentPlayFilePath = ""
    m.currentPlayFilename = ""
    m.folderBreadcrumb.text = "Initializing torrent stream for " + itemTitle + "..."
    m.currentTorrentTitle = itemTitle

    m.torrentInitTask = CreateObject("roSGNode", "HttpTask")
    m.torrentInitTask.url = m.torrentServerUrl + "/api/torrent/stream"
    m.torrentInitTask.method = "POST"
    m.torrentInitTask.timeoutMs = 90000
    m.torrentInitTask.postData = FormatJson({ url: linkUrl })
    m.torrentInitTask.observeField("result", "onTorrentInitResult")
    m.torrentInitTask.observeField("error", "onTorrentInitError")
    m.torrentInitTask.control = "run"
end sub

sub onTorrentInitResult()
    if m.torrentInitTask = invalid return
    result = m.torrentInitTask.result
    if result = invalid or result = ""
        m.folderBreadcrumb.text = "Torrent stream initialization failed"
        return
    end if

    data = ParseJSON(result)
    if data = invalid or data.success <> true
        if data <> invalid and data.error <> invalid
            m.folderBreadcrumb.text = "Torrent error: " + data.error
        else
            m.folderBreadcrumb.text = "Torrent stream initialization failed"
        end if
        return
    end if

    streamUrl = data.streamUrl
    if streamUrl = invalid or streamUrl = ""
        m.folderBreadcrumb.text = "No stream URL returned"
        return
    end if

    streamId = ""
    fileIndex = "0"
    segPos = Instr(1, streamUrl, "/api/torrent/serve/")
    if segPos > 0
        after = Mid(streamUrl, segPos + Len("/api/torrent/serve/"))
        slashPos = Instr(1, after, "/")
        if slashPos > 0
            streamId = Left(after, slashPos - 1)
            fileIndex = Mid(after, slashPos + 1)
            qPos = Instr(1, fileIndex, "?")
            if qPos > 0 then fileIndex = Left(fileIndex, qPos - 1)
        else
            streamId = after
        end if
    end if
    if data.streamId <> invalid and data.streamId <> "" then streamId = data.streamId
    if data.fileIndex <> invalid then fileIndex = Stri(data.fileIndex).trim()

    title = m.currentTorrentTitle
    if title = invalid or title = "" then title = data.title
    if title = invalid then title = "Torrent Stream"

    dt = CreateObject("roDateTime")
    m.playStartWallClock = dt.asSeconds().toStr()

    ' Check if media is native MP4 or non-native (MKV, AVI, HEVC, etc.)
    ' Roku cannot stream progressive MKV over HTTP without SeekHead/Cues at the start,
    ' and cannot decode multi-channel EAC3/DTS audio without transcoding to stereo AAC.
    ' Route all MKV / non-native torrents through the cloud server's HLS transcoder.
    checkName = LCase(title + " " + streamUrl)
    isNativeMp4 = (Instr(1, checkName, ".mp4") > 0 or Instr(1, checkName, ".m4v") > 0 or Instr(1, checkName, ".mov") > 0) and Instr(1, checkName, ".mkv") <= 0

    if isNativeMp4 and streamId = ""
        if Left(streamUrl, 4) <> "http"
            streamUrl = m.torrentServerUrl + streamUrl
        end if
        playVideoUrl(streamUrl, title, 0, "", false)
    else if streamId <> ""
        ' Route through cloud server HLS transcoder (m.serverUrl, NOT m.torrentServerUrl)
        hlsUrl = m.serverUrl + "/api/stream/torrent-hls/" + streamId + "/" + fileIndex + ".m3u8"
        m.pendingTorrentHlsUrl = hlsUrl
        m.pendingTorrentTitle = title
        m.folderBreadcrumb.text = "Preparing stream... (buffering initial video)"

        if m.torrentHlsWarmupTask <> invalid
            m.torrentHlsWarmupTask.control = "stop"
            m.torrentHlsWarmupTask = invalid
        end if
        m.torrentHlsWarmupTask = CreateObject("roSGNode", "HttpTask")
        m.torrentHlsWarmupTask.url = hlsUrl
        m.torrentHlsWarmupTask.method = "GET"
        m.torrentHlsWarmupTask.timeoutMs = 90000
        m.torrentHlsWarmupTask.observeField("result", "onTorrentHlsWarmupResult")
        m.torrentHlsWarmupTask.observeField("error", "onTorrentHlsWarmupError")
        m.torrentHlsWarmupTask.control = "run"
    else
        if Left(streamUrl, 4) <> "http"
            streamUrl = m.torrentServerUrl + streamUrl
        end if
        playVideoUrl(streamUrl, title, 0, "", false)
    end if
end sub

sub onTorrentHlsWarmupResult()
    if m.torrentHlsWarmupTask = invalid return
    res = m.torrentHlsWarmupTask.result
    if res = invalid or res = ""
        m.folderBreadcrumb.text = "Failed to load stream playlist"
        return
    end if

    title = m.pendingTorrentTitle
    if title = invalid or title = "" then title = "Torrent Stream"
    hlsUrl = m.pendingTorrentHlsUrl
    if hlsUrl = invalid or hlsUrl = "" return

    m.folderBreadcrumb.text = "Starting playback: " + title
    playVideoUrl(hlsUrl, title, 0, "", true)
end sub

sub onTorrentHlsWarmupError()
    errMsg = "Error preparing stream playlist"
    if m.torrentHlsWarmupTask <> invalid and m.torrentHlsWarmupTask.error <> invalid and m.torrentHlsWarmupTask.error <> ""
        if m.torrentHlsWarmupTask.error = "timeout"
            errMsg = "Stream prep timed out (peers/transcoding took >90s)"
        else
            errMsg = "Stream prep error: " + m.torrentHlsWarmupTask.error
        end if
    end if
    m.folderBreadcrumb.text = errMsg
end sub

sub onTorrentInitError()
    errMsg = "Error initializing torrent stream on server"
    if m.torrentInitTask <> invalid and m.torrentInitTask.error <> invalid and m.torrentInitTask.error <> ""
        if m.torrentInitTask.error = "timeout"
            errMsg = "Connecting to swarm timed out (finding peers took >90s)"
        else
            errMsg = "Torrent server error: " + m.torrentInitTask.error
        end if
    end if
    m.folderBreadcrumb.text = errMsg
end sub

sub playFreeTvStream(streamUrl as String, title as String)
    m.isLiveChannel = true
    m.bgTunedTitle = title
    m.justExitedPlayer = false
    m.currentEpisodeList = invalid
    m.currentEpisodeIndex = -1
    m.gridScreen.visible = false
    if m.playerScreen <> invalid then m.playerScreen.visible = true
    m.state = "player"
    m.triedTranscodeFallback = false
    m.initialPlayOffset = 0

    if streamUrl <> invalid and Left(streamUrl, 4) <> "http"
        streamUrl = m.serverUrl + streamUrl
    end if

    m.currentStreamUrl = streamUrl
    m.currentStreamTitle = title

    vidContent = CreateObject("roSGNode", "ContentNode")
    vidContent.url = streamUrl
    vidContent.title = title
    vidContent.streamFormat = "hls"
    vidContent.bufferingTargetSeconds = 12
    vidContent.PlayStart = 0

    m.video.content = vidContent
    m.video.visible = true
    m.video.setFocus(true)
    m.folderBreadcrumb.text = "Free TV: " + title
    m.video.control = "play"
end sub

sub playVideoUrl(streamUrl as String, title as String, offset = 0 as Float, filePath = "" as String, forceHls = false as Boolean)
    stopBackgroundPlayback()
    if m.state = "grid" and m.folderBreadcrumb <> invalid and m.folderBreadcrumb.text <> invalid
        if Left(m.folderBreadcrumb.text, 10) <> "Searching " and Left(m.folderBreadcrumb.text, 13) <> "Initializing "
            m.savedGridBreadcrumb = m.folderBreadcrumb.text
        end if
    end if
    m.isLiveChannel = false
    m.justExitedPlayer = false
    m.gridScreen.visible = false
    if m.playerScreen <> invalid then m.playerScreen.visible = true
    m.state = "player"
    m.triedTranscodeFallback = false
    if offset = 0 then m.triedStreamRetry = false
    m.bufferingStallCount = 0
    m.lastBufferingPercent = 0
    m.initialPlayOffset = offset
    m.hasPlayedContent = false
    m.nextChunkWarmOffset = -1
    if m.chunkWarmTask <> invalid
        m.chunkWarmTask.control = "stop"
        m.chunkWarmTask = invalid
    end if

    isTorrent = Instr(1, LCase(streamUrl), "/api/torrent/stream/") > 0 or Instr(1, LCase(streamUrl), "download.butfree.online") > 0 or Instr(1, LCase(streamUrl), "torrent.liftedpixel.ca") > 0 or Instr(1, LCase(streamUrl), "/api/stream/torrent-hls/") > 0 or Instr(1, LCase(streamUrl), "/api/torrent/serve/") > 0
    isDrive = Instr(1, LCase(streamUrl), "/api/stream/drive/") > 0
    playUrl = streamUrl
    m.currentStreamUrl = playUrl
    m.currentStreamTitle = title
    m.pendingPlayUrl = playUrl
    m.pendingPlayTitle = title
    m.pendingIsTorrent = isTorrent
    m.pendingFilePath = filePath

    vidContent = CreateObject("roSGNode", "ContentNode")
    vidContent.url = playUrl
    vidContent.title = title
    vidContent.bufferingTargetSeconds = 12
    if forceHls
        vidContent.streamFormat = "hls"
        vidContent.live = false
        ' The server handles seeking via offset (-ss) for transcoded HLS streams,
        ' so the transcoded stream's timeline begins at 0.
        vidContent.PlayStart = 0
    else if isTorrent
        vidContent.streamFormat = detectStreamFormat(streamUrl + " " + filePath + " " + title)
        if offset > 0
            vidContent.PlayStart = offset
        end if
    else if isDrive
        vidContent.streamFormat = detectStreamFormat(streamUrl + " " + filePath + " " + title)
        if offset > 0
            vidContent.PlayStart = offset
        else
            vidContent.PlayStart = 0
        end if
    else
        vidContent.streamFormat = "hls"
        vidContent.live = false
        if isChunkedHlsStream()
            vidContent.PlayStart = 0
        else if offset > 0
            vidContent.PlayStart = offset
        else
            vidContent.PlayStart = 0
        end if
    end if

    m.video.content = vidContent
    m.video.visible = true
    m.video.setFocus(true)
    m.folderBreadcrumb.text = title

    if m.playDelayTimer <> invalid
        m.playDelayTimer.control = "stop"
        m.top.removeChild(m.playDelayTimer)
        m.playDelayTimer = invalid
    end if
    m.playDelayTimer = CreateObject("roSGNode", "Timer")
    m.playDelayTimer.duration = 0.5
    m.playDelayTimer.observeField("fire", "onPlayDelayFired")
    m.top.appendChild(m.playDelayTimer)
    m.playDelayTimer.control = "start"

    if isLoggedIn()
        startProgressTimer()
    end if
end sub

function detectStreamFormat(str as String) as String
    if str = invalid return "mp4"
    lStr = LCase(str)
    if Instr(1, lStr, "drive-hls") > 0 or Instr(1, lStr, "hls=true") > 0 or Instr(1, lStr, "hls=1") > 0
        return "hls"
    end if
    if Instr(1, lStr, "transcode=true") > 0 or Instr(1, lStr, "transcode=1") > 0
        return "mp4"
    end if
    if Instr(1, lStr, ".m3u8") > 0 or Instr(1, lStr, "%2em3u8") > 0
        return "hls"
    else if Instr(1, lStr, ".mkv") > 0 or Instr(1, lStr, ".webm") > 0 or Instr(1, lStr, "%2emkv") > 0 or Instr(1, lStr, "%2ewebm") > 0
        return "mkv"
    else if Instr(1, lStr, ".mp4") > 0 or Instr(1, lStr, ".mov") > 0 or Instr(1, lStr, ".m4v") > 0 or Instr(1, lStr, "%2emp4") > 0 or Instr(1, lStr, "%2emov") > 0 or Instr(1, lStr, "%2em4v") > 0
        return "mp4"
    else if Instr(1, lStr, ".wmv") > 0 or Instr(1, lStr, ".asf") > 0 or Instr(1, lStr, ".avi") > 0 or Instr(1, lStr, "%2ewmv") > 0 or Instr(1, lStr, "%2easf") > 0 or Instr(1, lStr, "%2eavi") > 0
        return "wmf"
    end if
    return "mp4"
end function

function appendHlsParam(url as String, offset = 0 as Float) as String
    hlsStr = "hls=true"
    if offset > 0
        hlsStr = "hls=true&offset=" + Stri(Fix(offset)).trim()
    end if

    if Instr(1, LCase(url), "hls=true") > 0 or Instr(1, LCase(url), "hls=1") > 0
        if offset > 0 and Instr(1, LCase(url), "offset=") <= 0
            if Instr(1, url, "?") > 0
                return url + "&offset=" + Stri(Fix(offset)).trim()
            else
                return url + "?offset=" + Stri(Fix(offset)).trim()
            end if
        end if
        return url
    end if

    if Instr(1, url, "?") > 0
        return url + "&" + hlsStr
    else
        return url + "?" + hlsStr
    end if
end function

function appendTranscodeParam(url as String) as String
    if Instr(1, url, "?") > 0
        return url + "&transcode=true"
    else
        return url + "?transcode=true"
    end if
end function

function isChunkedHlsStream() as Boolean
    url = safeStr(m.currentStreamUrl)
    lUrl = LCase(url)
    if lUrl = "" return false
    return Instr(1, lUrl, "drive-hls") > 0 or Instr(1, lUrl, "torrent-hls") > 0
end function

' Transcoded Drive/torrent content is served in bounded ~2-hour VOD chunks (each ending with
' #EXT-X-ENDLIST). When a chunk plays to its end, chain to the next chunk by restarting the
' same HLS URL with an increased ?offset=. A chunk that played less than ~3s is the server's
' end-of-stream playlist, so the content is over.
function chunkSeconds() as Integer
    if m.serverChunkSeconds <> invalid and m.serverChunkSeconds > 0
        return m.serverChunkSeconds
    end if
    ' Default matches HLS_CHUNK_SECONDS in server.js (7200 = 2 hours).
    return 7200
end function

function rebuildStreamUrlWithOffset(url as String, newOffset as Integer) as String
    if url = "" return ""
    newOff = "offset=" + Stri(newOffset).trim()
    offIdx = Instr(1, url, "&offset=")
    if offIdx = 0 then offIdx = Instr(1, url, "?offset=")
    if offIdx > 0
        pre = Left(url, offIdx)
        rest = Mid(url, offIdx + 1)
        qIdx = Instr(1, rest, "&")
        post = ""
        if qIdx > 0 then post = Mid(rest, qIdx)
        return pre + newOff + post
    else
        sep = "&"
        if Instr(1, url, "?") = 0 then sep = "?"
        return url + sep + newOff
    end if
end function

function chainToNextHlsChunk() as Boolean
    if m.video = invalid or m.video.content = invalid return false
    if not isChunkedHlsStream() return false

    ' If the video went straight to "finished" without ever entering "playing", the
    ' playlist was empty (terminal ENDLIST). Stop chaining to prevent runaway loop.
    if not m.hasPlayedContent return false

    vidDur = m.video.duration
    if vidDur = invalid then vidDur = 0
    playedSec = Int(vidDur)
    if playedSec < 3 return false

    ' If the playlist played to its natural end and its duration was significantly
    ' less than the expected chunk size (e.g. video was 20 mins while chunk size was 30 mins / 2 hrs),
    ' then the video file has finished! Do NOT attempt to chain to a non-existent next chunk.
    if playedSec < (chunkSeconds() - 15)
        print "[ChunkChain] Video finished at natural end-of-file (played "; playedSec; "s < chunk "; chunkSeconds(); "s). Not chaining."
        return false
    end if

    ' Use the fixed chunk size (not the measured duration) so the chain offset exactly
    ' matches the ?offset= that was already pre-warmed on the server.
    startOffset = 0
    if m.initialPlayOffset <> invalid then startOffset = m.initialPlayOffset
    nextOffset = startOffset + chunkSeconds()

    newUrl = rebuildStreamUrlWithOffset(safeStr(m.currentStreamUrl), nextOffset)
    if newUrl = "" or newUrl = safeStr(m.currentStreamUrl) return false

    retryFile = m.currentPlayFilename
    if retryFile = invalid or retryFile = "" then retryFile = m.currentPlayFilePath
    playVideoUrl(newUrl, m.currentStreamTitle, nextOffset, retryFile, true)
    return true
end function

' Fire-and-forget: ask the server to start transcoding the NEXT chunk while this one plays.
' By the time this chunk finishes, the next playlist already exists, so the chain request
' hits the reuse path (instant 302, no buffering gap).
sub startNextChunkWarm()
    if not isChunkedHlsStream() return
    cur = safeStr(m.currentStreamUrl)
    if cur = "" return

    startOffset = 0
    if m.initialPlayOffset <> invalid then startOffset = m.initialPlayOffset
    target = startOffset + chunkSeconds()

    if m.nextChunkWarmOffset <> -1 and m.nextChunkWarmOffset = target return
    if m.chunkWarmTask <> invalid and m.chunkWarmTask.control = "run" return

    warmUrl = rebuildStreamUrlWithOffset(cur, target)
    if warmUrl = "" or warmUrl = cur return

    m.nextChunkWarmOffset = target
    m.chunkWarmTask = CreateObject("roSGNode", "HttpTask")
    m.chunkWarmTask.url = warmUrl
    m.chunkWarmTask.observeField("response", "onChunkWarmResponse")
    m.chunkWarmTask.control = "run"
    print "[ChunkWarm] pre-warming next chunk offset="; target
end sub

sub onChunkWarmResponse()
    print "[ChunkWarm] pre-warm request finished"
end sub

sub onPlayDelayFired()
    if m.playDelayTimer <> invalid
        m.playDelayTimer.control = "stop"
        m.top.removeChild(m.playDelayTimer)
        m.playDelayTimer = invalid
    end if
    if m.video <> invalid
        m.video.control = "play"
    end if
end sub

sub startBufferingWatchdog()
    if m.state <> "player" or m.isLiveChannel = true return
    m.lastBufferingPercent = 0
    if m.bufferingWatchdogTimer = invalid
        m.bufferingWatchdogTimer = CreateObject("roSGNode", "Timer")
        m.bufferingWatchdogTimer.duration = 25
        m.bufferingWatchdogTimer.repeat = false
        m.bufferingWatchdogTimer.observeField("fire", "onBufferingWatchdogFired")
        m.top.appendChild(m.bufferingWatchdogTimer)
    end if
    m.bufferingWatchdogTimer.duration = 25
    m.bufferingWatchdogTimer.control = "stop"
    m.bufferingWatchdogTimer.control = "start"
end sub

sub stopBufferingWatchdog()
    if m.bufferingWatchdogTimer <> invalid
        m.bufferingWatchdogTimer.control = "stop"
    end if
end sub

sub onBufferingStatusChange()
    if m.video = invalid or m.video.bufferingStatus = invalid return
    status = m.video.bufferingStatus
    pct = 0
    if status.percentage <> invalid then pct = status.percentage
    ' If buffering percentage is actively progressing or positive, refresh watchdog to allow download to finish
    if pct > m.lastBufferingPercent or (pct > 0 and m.bufferingWatchdogTimer <> invalid and m.bufferingWatchdogTimer.duration < 15)
        m.lastBufferingPercent = pct
        if m.bufferingWatchdogTimer <> invalid and m.bufferingWatchdogTimer.control = "start"
            m.bufferingWatchdogTimer.control = "stop"
            m.bufferingWatchdogTimer.duration = 25
            m.bufferingWatchdogTimer.control = "start"
        end if
    end if
end sub

sub onBufferingWatchdogFired()
    stopBufferingWatchdog()
    if m.state = "player" and m.video <> invalid and m.video.state = "buffering" and m.isLiveChannel <> true
        vidPos = m.video.position
        if vidPos = invalid then vidPos = 0
        startOffset = 0
        if m.initialPlayOffset <> invalid then startOffset = m.initialPlayOffset
        curOffset = startOffset + vidPos

        if m.bufferingStallCount = invalid then m.bufferingStallCount = 0
        m.bufferingStallCount = m.bufferingStallCount + 1
        print "[Watchdog] Buffering stalled (stall #"; m.bufferingStallCount; ") for 25s at offset: "; curOffset

        ' First stall detection: allow an extra 15s grace period before tearing down playback
        if m.bufferingStallCount < 2
            m.folderBreadcrumb.text = "Buffering... (waiting for stream)"
            if m.bufferingWatchdogTimer <> invalid
                m.bufferingWatchdogTimer.duration = 15
                m.bufferingWatchdogTimer.control = "start"
            end if
            return
        end if

        ' Maximum 1 hard recovery attempt to prevent endless restart loops
        if m.bufferingStallCount > 2
            print "[Watchdog] Maximum recovery attempts reached for offset "; curOffset; ". Not retrying."
            m.folderBreadcrumb.text = "Stream interrupted. Press Back to exit."
            return
        end if

        if curOffset > 5 and m.currentStreamUrl <> invalid and m.currentStreamUrl <> ""
            m.folderBreadcrumb.text = "Stream stalled. Recovering at " + Stri(Fix(curOffset)).trim() + "s..."
            retryFile = m.currentPlayFilename
            if retryFile = invalid or retryFile = "" then retryFile = m.currentPlayFilePath
            isHls = false
            if m.video.content <> invalid and m.video.content.streamFormat = "hls" then isHls = true
            if isHls
                ' For HLS streams, the server handles seeking via -ss offset, so the
                ' transcoded playlist timeline starts at 0. Do NOT pass the offset as
                ' PlayStart — Roku would look for segment N (misaligned) while the
                ' server produces segments starting at 0. The offset is appended to
                ' the URL as a query param for the server to use.
                resumeUrl = m.currentStreamUrl
                newOffsetParam = "offset=" + Stri(Fix(curOffset)).trim()
                offIdx = Instr(1, resumeUrl, "&offset=")
                if offIdx = 0 then offIdx = Instr(1, resumeUrl, "?offset=")
                if offIdx > 0
                    ' Replace existing offset parameter value (offIdx points at & or ?)
                    pre = Left(resumeUrl, offIdx)
                    rest = Mid(resumeUrl, offIdx + 1)
                    qIdx = Instr(1, rest, "&")
                    if qIdx > 0
                        post = Mid(rest, qIdx)
                    else
                        post = ""
                    end if
                    resumeUrl = pre + newOffsetParam + post
                else
                    sep = "&"
                    if Instr(1, resumeUrl, "?") = 0 then sep = "?"
                    resumeUrl = resumeUrl + sep + newOffsetParam
                end if
                playVideoUrl(resumeUrl, m.currentStreamTitle, curOffset, retryFile, true)
            else
                playVideoUrl(m.currentStreamUrl, m.currentStreamTitle, curOffset, retryFile, false)
            end if
        end if
    end if
end sub

sub onVideoStateChange()
    st = m.video.state

    if st = "playing"
        stopBufferingWatchdog()
        m.bufferingStallCount = 0
        m.lastBufferingPercent = 0
        m.hasPlayedContent = true
        if m.homeBg <> invalid then m.homeBg.visible = false
        if m.state = "player"
            m.gridScreen.visible = false
            if m.playerScreen <> invalid then m.playerScreen.visible = true
        end if
        return
    end if

    if st = "buffering"
        startBufferingWatchdog()
        return
    end if

    stopBufferingWatchdog()

    if m.state = "grid"
        if st = "error"
            if m.homeBg <> invalid then m.homeBg.visible = true
            m.video.visible = false
            m.video.control = "stop"
        end if
        return
    end if

    if st = "finished" or st = "stopped"
        chainedChunk = false
        if st = "finished" and isChunkedHlsStream()
            chainedChunk = chainToNextHlsChunk()
        end if

        if chainedChunk
            return
        end if

        if isLoggedIn() and m.currentPlayFilePath <> "" and m.currentPlayFilePath <> invalid
            vidDur = m.video.duration
            if vidDur = invalid then vidDur = 0
            submitPlaybackProgress(m.currentPlayFilePath, vidDur, vidDur, m.currentStreamTitle, m.currentPlayingItemType, m.currentPlayingShow, m.currentPlayingSeason, m.currentPlayingEpisode, m.currentPlayingPoster)
        end if
        if m.progressTimer <> invalid then m.progressTimer.control = "stop"

        if st = "finished" and playNextDriveEpisode()
            return
        end if

        stopAllActiveStreams()

        m.state = "grid"
        m.justExitedPlayer = false

        m.video.control = "stop"
        m.video.visible = false
        if m.homeBg <> invalid then m.homeBg.visible = true
        if m.playerScreen <> invalid then m.playerScreen.visible = false
        m.gridScreen.visible = true
        if m.savedGridBreadcrumb <> invalid and m.savedGridBreadcrumb <> ""
            m.folderBreadcrumb.text = m.savedGridBreadcrumb
        end if
        restoreGridFocus()
    else if st = "error"
        errCode = ""
        errMsg = ""
        if m.video.errorCode <> invalid then errCode = Stri(m.video.errorCode).trim()
        if m.video.errorMsg <> invalid then errMsg = m.video.errorMsg

        if m.triedTranscodeFallback <> true and m.currentStreamUrl <> invalid and m.currentStreamUrl <> ""
            m.triedTranscodeFallback = true
            fallbackUrl = m.currentStreamUrl
            if Instr(1, LCase(fallbackUrl), "/api/stream/drive/") > 0
                driveId = ""
                if m.currentPlayFilePath <> invalid and Len(m.currentPlayFilePath) >= 8 and Left(m.currentPlayFilePath, 8) = "drive://"
                    driveId = Mid(m.currentPlayFilePath, 9)
                end if
                if driveId <> ""
                    fallbackUrl = m.serverUrl + "/api/stream/drive-hls/" + driveId
                    if isLoggedIn() then fallbackUrl = fallbackUrl + "?token=" + m.authToken
                    vidPos = m.video.position
                    if vidPos = invalid then vidPos = 0
                    startOffset = 0
                    if m.initialPlayOffset <> invalid then startOffset = m.initialPlayOffset
                    curOffset = startOffset + vidPos
                    if curOffset > 5
                        if Instr(1, fallbackUrl, "?") > 0
                            fallbackUrl = fallbackUrl + "&offset=" + Stri(Fix(curOffset)).trim()
                        else
                            fallbackUrl = fallbackUrl + "?offset=" + Stri(Fix(curOffset)).trim()
                        end if
                    end if
                end if
            else if Instr(1, LCase(fallbackUrl), "/api/torrent/serve/") > 0
                ' Direct torrent playback failed -> Fallback to cloud server HLS transcoding
                segPos = Instr(1, fallbackUrl, "/api/torrent/serve/")
                after = Mid(fallbackUrl, segPos + Len("/api/torrent/serve/"))
                segEnd = Instr(1, after, "/")
                tStreamId = ""
                tFileIdx = "0"
                if segEnd > 0
                    tStreamId = Left(after, segEnd - 1)
                    tFileIdx = Mid(after, segEnd + 1)
                    qPos = Instr(1, tFileIdx, "?")
                    if qPos > 0 then tFileIdx = Left(tFileIdx, qPos - 1)
                else
                    tStreamId = after
                end if
                if tStreamId <> ""
                    fallbackUrl = m.serverUrl + "/api/stream/torrent-hls/" + tStreamId + "/" + tFileIdx + ".m3u8"
                end if
            else if Instr(1, LCase(fallbackUrl), "transcode=true") <= 0 and Instr(1, LCase(fallbackUrl), "transcode=1") <= 0
                fallbackUrl = appendTranscodeParam(fallbackUrl)
            end if
            m.folderBreadcrumb.text = "Native decoder unsupported (" + errCode + "). Transcoding stream..."
            m.video.control = "stop"

            vidContent = CreateObject("roSGNode", "ContentNode")
            vidContent.url = fallbackUrl
            vidContent.title = m.currentStreamTitle
            vidContent.streamFormat = detectStreamFormat(fallbackUrl)
            vidContent.PlayStart = 0
            m.video.content = vidContent
            m.video.visible = true
            m.video.setFocus(true)
            m.video.control = "play"
            return
        end if

        if m.triedStreamRetry <> true and m.currentStreamUrl <> invalid and m.currentStreamUrl <> "" and m.currentPlayFilePath <> invalid and m.currentPlayFilePath <> ""
            m.triedStreamRetry = true
            vidPos = m.video.position
            if vidPos = invalid then vidPos = 0
            startOffset = 0
            if m.initialPlayOffset <> invalid then startOffset = m.initialPlayOffset
            resumePos = startOffset + vidPos
            if resumePos > 10
                m.folderBreadcrumb.text = "Recovering stream at " + Stri(Int(resumePos)).trim() + "s..."
                retryFile = m.currentPlayFilename
                if retryFile = invalid or retryFile = "" then retryFile = m.currentPlayFilePath
                isHlsRetry = false
                if m.video.content <> invalid and m.video.content.streamFormat = "hls" then isHlsRetry = true
                if isHlsRetry
                    ' HLS: server handles seeking via -ss, timeline starts at 0.
                    ' Pass offset as URL param, PlayStart = 0.
                    resumeUrl = m.currentStreamUrl
                    newOff = "offset=" + Stri(Fix(resumePos)).trim()
                    offIdx2 = Instr(1, resumeUrl, "&offset=")
                    if offIdx2 = 0 then offIdx2 = Instr(1, resumeUrl, "?offset=")
                    if offIdx2 > 0
                        ' Replace existing offset parameter value (offIdx2 points at & or ?)
                        pre2 = Left(resumeUrl, offIdx2)
                        rest2 = Mid(resumeUrl, offIdx2 + 1)
                        qIdx2 = Instr(1, rest2, "&")
                        if qIdx2 > 0
                            post2 = Mid(rest2, qIdx2)
                        else
                            post2 = ""
                        end if
                        resumeUrl = pre2 + newOff + post2
                    else
                        sep2 = "&"
                        if Instr(1, resumeUrl, "?") = 0 then sep2 = "?"
                        resumeUrl = resumeUrl + sep2 + newOff
                    end if
                    playVideoUrl(resumeUrl, m.currentStreamTitle, resumePos, retryFile, true)
                else
                    playVideoUrl(m.currentStreamUrl, m.currentStreamTitle, resumePos, retryFile)
                end if
                return
            end if
        end if

        m.triedTranscodeFallback = false
        m.triedStreamRetry = false
        stopAllActiveStreams()
        m.video.control = "stop"
        m.video.visible = false
        if m.homeBg <> invalid then m.homeBg.visible = true
        if m.playerScreen <> invalid then m.playerScreen.visible = false
        m.gridScreen.visible = true
        m.folderBreadcrumb.text = "Playback Error (" + errCode + "): " + errMsg
        restoreGridFocus()
        m.state = "grid"
    end if
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    k = LCase(key)

    if m.state = "player" or (m.video <> invalid and m.video.visible = true)
        if k = "back"
            if press
                stopAllActiveStreams()
                m.video.control = "stop"
                m.video.visible = false
                if m.homeBg <> invalid then m.homeBg.visible = true
                if m.playerScreen <> invalid then m.playerScreen.visible = false
                m.gridScreen.visible = true
                m.state = "grid"
                if m.savedGridBreadcrumb <> invalid and m.savedGridBreadcrumb <> ""
                    m.folderBreadcrumb.text = m.savedGridBreadcrumb
                end if
                restoreGridFocus()
            end if
            return true
        else if (k = "ok" or k = "play" or k = "pause" or k = "playpause") and m.isLiveChannel <> true
            if press
                if m.video.state = "paused"
                    m.video.control = "resume"
                else
                    m.video.control = "pause"
                end if
            end if
            return true
        else if k = "options" or k = "star"
            if press
                stopAllActiveStreams()
                m.video.control = "stop"
                m.video.visible = false
                if m.homeBg <> invalid then m.homeBg.visible = true
                if m.playerScreen <> invalid then m.playerScreen.visible = false
                m.gridScreen.visible = true
                m.state = "grid"
                restoreGridFocus()
            end if
            return true
        end if
        return false
    end if

    if m.top.dialog <> invalid
        if key = "back"
            if press
                m.top.dialog.close = true
                if m.navStack.count() = 0 and m.cwGrid.visible
                    m.cwGrid.setFocus(true)
                else if m.posterGrid <> invalid
                    m.posterGrid.setFocus(true)
                end if
            end if
            return true
        end if
        if not press then return false
        return false
    end if

    if not press return false

    if (k = "play" or k = "pause" or k = "playpause") and m.state = "grid" and m.sidebarFocused = false and m.isIpFocused = false
        if isLoggedIn()
            toggleFocusedFavorite()
            return true
        else
            showNotification("Sign In Required", "Please sign in to save favorites")
            return true
        end if
    end if

    if (k = "options" or k = "star") and m.state = "grid" and m.top.dialog = invalid
        startUnifiedSearchEdit()
        return true
    end if

    if m.isIpFocused
        if key = "down"
            m.isIpFocused = false
            updateIpHighlight()
            if m.navStack.count() = 0 and m.cwGrid.visible
                m.cwGrid.setFocus(true)
            else
                m.posterGrid.setFocus(true)
            end if
            return true
        end if
        return true
    end if

    if m.sidebarFocused and m.top.dialog = invalid
        if key = "up"
            if m.sidebarIndex > 0
                m.sidebarIndex = m.sidebarIndex - 1
                updateSidebarNav()
            end if
            return true
        else if key = "down"
            if m.sidebarIndex < m.navLabels.count() - 1
                m.sidebarIndex = m.sidebarIndex + 1
                updateSidebarNav()
            end if
            return true
        else if key = "OK"
            activateSidebarItem(m.sidebarIndex)
            return true
        else if key = "right" or key = "back"
            closeSidebarNav(true)
            return true
        end if
        return true
    end if

    if key = "left"
        if m.state = "grid" and m.navStack.count() = 0
            openSidebarNav()
            return true
        end if
        if m.state = "grid" and m.navStack.count() > 0 and m.posterGrid.hasFocus()
            focusedIdx = m.posterGrid.itemFocused
            cols = m.posterGrid.numColumns
            if cols < 1 then cols = 1
            if focusedIdx >= 0 and (focusedIdx mod cols) = 0
                openSidebarNav()
                return true
            end if
        end if
    else if key = "up"
        if m.state = "grid" and m.navStack.count() = 0
            if m.cwGrid.hasFocus()
                m.isIpFocused = true
                updateIpHighlight()
                return true
            end if
        end if
        if m.state = "grid" and m.navStack.count() > 0 and m.posterGrid.hasFocus()
            m.isIpFocused = true
            updateIpHighlight()
            return true
        end if
    else if key = "down"
        if m.state = "grid" and m.navStack.count() = 0
            if m.cwGrid.visible and m.cwGrid.hasFocus() and m.posterGrid.visible
                m.posterGrid.setFocus(true)
                return true
            end if
        end if
    else if key = "back"
        if m.state = "grid"
            if m.cwGrid.hasFocus() and m.navStack.count() > 0
                m.posterGrid.setFocus(true)
                return true
            end if
            if popState()
                return true
            end if
        end if
    end if

    return false
end function

sub restoreGridFocus()
    if m.cwGrid <> invalid and m.cwGrid.visible = true and m.cwItems <> invalid and m.cwItems.count() > 0
        m.cwGrid.setFocus(true)
    else if m.posterGrid <> invalid and m.posterGrid.visible = true and m.posterGrid.content <> invalid and m.posterGrid.content.getChildCount() > 0
        m.posterGrid.setFocus(true)
    else if m.sidebar <> invalid and m.sidebar.visible = true
        m.sidebar.setFocus(true)
    else
        m.top.setFocus(true)
    end if
end sub

sub updateSidebarNav()
    if m.navLabels = invalid then return
    for i = 0 to m.navLabels.count() - 1
        hi = m.navHighlights[i]
        lbl = m.navLabels[i]
        isFocusedItem = m.sidebarFocused and i = m.sidebarIndex
        hi.visible = isFocusedItem
        if isFocusedItem
            lbl.color = "0xFFFFFFFF"
        else if i = m.activeSidebar
            lbl.color = "0xE50914FF"
        else
            lbl.color = "0xA3A8B8FF"
        end if
    end for
end sub

sub setSidebarExpanded(expanded as Boolean)
    m.sidebarExpanded = expanded
    if m.sidebar = invalid then return
    if expanded
        m.sidebarBg.width = 220
        m.sidebarEdge.translation = [219, 0]
        m.sidebar.clippingRect = [0, 0, 220, 720]
        m.sidebarLogoText.visible = true
        for each hi in m.navHighlights
            hi.width = 204
        end for
        for each lbl in m.navLabels
            lbl.visible = true
        end for
    else
        m.sidebarBg.width = 76
        m.sidebarEdge.translation = [75, 0]
        m.sidebar.clippingRect = [0, 0, 76, 720]
        m.sidebarLogoText.visible = false
        for each hi in m.navHighlights
            hi.width = 60
        end for
        for each lbl in m.navLabels
            lbl.visible = false
        end for
    end if
end sub

sub openSidebarNav()
    m.sidebarFocused = true
    setSidebarExpanded(true)
    updateSidebarNav()
    m.sidebar.setFocus(true)
end sub

sub closeSidebarNav(refocusGrid as Boolean)
    m.sidebarFocused = false
    setSidebarExpanded(false)
    updateSidebarNav()
    if refocusGrid
        if m.navStack.count() = 0 and m.cwGrid.visible
            m.cwGrid.setFocus(true)
        else
            m.posterGrid.setFocus(true)
        end if
    end if
end sub

sub activateSidebarItem(idx as Integer)
    closeSidebarNav(true)
    if idx < 0 or idx >= m.navLabels.count() return
    lbl = m.navLabels[idx]
    if lbl = invalid return
    action = lbl.text

    if action = "Home"
        showHomeScreen()
    else if action = "Search"
        startUnifiedSearchEdit()
    else if action = "Drive"
        openDriveGrid()
    else if action = "Faves"
        openFavoritesGrid()
    else if action = "Services"
        openServicesRootGrid()
    else if action = "Free TV"
        openFreeTvGrid()
    else if action = "Sign Out"
        handleSignOut()
    else if action = "Sign In"
        showLoginScreen()
    end if
end sub

sub startUnifiedSearchEdit()
    keyboardDlg = CreateObject("roSGNode", "StandardKeyboardDialog")
    keyboardDlg.title = "Search Cloud & Torrents"
    keyboardDlg.text = ""
    keyboardDlg.buttons = ["Search", "Cancel"]
    keyboardDlg.observeField("buttonSelected", "onSearchDialogButton")
    m.top.dialog = keyboardDlg
end sub

sub onSearchDialogButton()
    dialog = m.top.dialog
    if dialog = invalid return
    buttonIdx = dialog.buttonSelected

    if buttonIdx = 0
        queryStr = dialog.text.trim()
        if queryStr <> ""
            performUnifiedSearch(queryStr)
        end if
    end if
    dialog.close = true
end sub

sub performUnifiedSearch(queryStr as String)
    m.lastSearchQuery = queryStr
    m.activeSidebar = 1
    updateSidebarNav()
    pushCurrentState("Search: '" + queryStr + "'")
    m.folderBreadcrumb.text = "Searching '" + queryStr + "'..."

    m.heroGroup.visible = false
    m.cwLabel.visible = false
    m.cwGrid.visible = false
    if m.pairingGroup <> invalid then m.pairingGroup.visible = false
    m.posterGrid.visible = true

    ' 1. Local search across Drive library, FAST channels, and Fresh/Popular catalog
    m.searchLibraryTv = []
    m.searchLibraryMovies = []
    m.searchChannels = []
    m.searchWhatson = []
    m.searchMovieTorrents = []
    m.searchTvTorrents = []

    qLower = LCase(queryStr)

    ' Search Drive TV Shows & Episodes
    if m.driveShows <> invalid and m.driveShowsList <> invalid
        for each showName in m.driveShowsList
            sLower = LCase(showName)
            showMatches = (Instr(1, sLower, qLower) > 0)
            seasons = m.driveShows[showName]
            if seasons <> invalid
                for each sKey in seasons
                    eps = seasons[sKey]
                    if eps <> invalid
                        for each ep in eps
                            epTitle = ""
                            epFile = ""
                            if ep.title <> invalid then epTitle = ep.title.toStr()
                            if ep.filename <> invalid then epFile = ep.filename.toStr()
                            if showMatches or Instr(1, LCase(epTitle), qLower) > 0 or Instr(1, LCase(epFile), qLower) > 0
                                pUrl = "pkg:/images/tv-shows.jpg"
                                if ep.posterUrl <> invalid and ep.posterUrl <> ""
                                    pUrl = ep.posterUrl
                                else if m.driveLibrary <> invalid and m.driveLibrary.showsPosters <> invalid and m.driveLibrary.showsPosters[showName] <> invalid
                                    pUrl = m.driveLibrary.showsPosters[showName]
                                end if
                                m.searchLibraryTv.push({
                                    show: showName,
                                    title: epTitle,
                                    filename: epFile,
                                    driveId: safeStr(ep.driveId),
                                    mediaPath: safeStr(ep.path),
                                    season: safeStr(ep.season),
                                    episode: safeStr(ep.episode),
                                    posterUrl: pUrl
                                })
                                if m.searchLibraryTv.count() >= 30 then exit for
                            end if
                        end for
                    end if
                    if m.searchLibraryTv.count() >= 30 then exit for
                end for
            end if
            if m.searchLibraryTv.count() >= 30 then exit for
        end for
    end if

    ' Search Drive Movies
    if m.driveMovies <> invalid
        for each movie in m.driveMovies
            mTitle = safeStr(movie.title)
            mFile = safeStr(movie.filename)
            if Instr(1, LCase(mTitle), qLower) > 0 or Instr(1, LCase(mFile), qLower) > 0
                pUrl = getDriveMoviePoster(movie)
                m.searchLibraryMovies.push({
                    title: mTitle,
                    filename: mFile,
                    driveId: safeStr(movie.driveId),
                    mediaPath: safeStr(movie.path),
                    posterUrl: pUrl
                })
                if m.searchLibraryMovies.count() >= 30 then exit for
            end if
        end for
    end if

    ' Search Free TV Channels if loaded
    if m.allFreeTvChannels <> invalid
        for each ch in m.allFreeTvChannels
            chName = safeStr(ch.name)
            chProv = safeStr(ch.provider)
            chCat = safeStr(ch.category)
            if Instr(1, LCase(chName), qLower) > 0 or Instr(1, LCase(chProv), qLower) > 0 or Instr(1, LCase(chCat), qLower) > 0
                m.searchChannels.push(ch)
                if m.searchChannels.count() >= 20 then exit for
            end if
        end for
    end if

    ' Search Fresh / Popular items if loaded
    freshItems = []
    if m.homeFreshWhatsonData <> invalid and m.homeFreshWhatsonData.items <> invalid
        for each it in m.homeFreshWhatsonData.items
            freshItems.push(it)
        end for
    end if
    if m.homeFreshMovieData <> invalid and m.homeFreshMovieData.results <> invalid
        for each it in m.homeFreshMovieData.results
            freshItems.push(it)
        end for
    end if
    if m.homeFreshTvData <> invalid and m.homeFreshTvData.results <> invalid
        for each it in m.homeFreshTvData.results
            freshItems.push(it)
        end for
    end if
    for each item in freshItems
        itTitle = safeStr(item.title)
        if itTitle <> "" and Instr(1, LCase(itTitle), qLower) > 0
            m.searchWhatson.push(item)
            if m.searchWhatson.count() >= 15 then exit for
        end if
    end for

    ' Render immediately with any local matches found so far
    renderUnifiedSearchResults()

    ' 2. Parallel cloud server torrent queries for movies and tv
    m.searchTasksPending = 2

    m.searchMovieTask = CreateObject("roSGNode", "HttpTask")
    m.searchMovieTask.url = m.serverUrl + "/api/torrent-search?q=" + encodePath(queryStr) + "&type=movie"
    m.searchMovieTask.observeField("result", "onSearchMovieResult")
    m.searchMovieTask.observeField("error", "onSearchMovieError")
    m.searchMovieTask.control = "run"

    m.searchTvTask = CreateObject("roSGNode", "HttpTask")
    m.searchTvTask.url = m.serverUrl + "/api/torrent-search?q=" + encodePath(queryStr) + "&type=tv"
    m.searchTvTask.observeField("result", "onSearchTvResult")
    m.searchTvTask.observeField("error", "onSearchTvError")
    m.searchTvTask.control = "run"
end sub

sub onSearchMovieResult()
    if m.searchMovieTask <> invalid and m.searchMovieTask.result <> invalid and m.searchMovieTask.result <> ""
        data = ParseJSON(m.searchMovieTask.result)
        if data <> invalid and data.results <> invalid
            m.searchMovieTorrents = data.results
        end if
    end if
    m.searchTasksPending = m.searchTasksPending - 1
    renderUnifiedSearchResults()
end sub

sub onSearchMovieError()
    m.searchTasksPending = m.searchTasksPending - 1
    renderUnifiedSearchResults()
end sub

sub onSearchTvResult()
    if m.searchTvTask <> invalid and m.searchTvTask.result <> invalid and m.searchTvTask.result <> ""
        data = ParseJSON(m.searchTvTask.result)
        if data <> invalid and data.results <> invalid
            m.searchTvTorrents = data.results
        end if
    end if
    m.searchTasksPending = m.searchTasksPending - 1
    renderUnifiedSearchResults()
end sub

sub onSearchTvError()
    m.searchTasksPending = m.searchTasksPending - 1
    renderUnifiedSearchResults()
end sub

sub renderUnifiedSearchResults()
    gridContent = CreateObject("roSGNode", "ContentNode")
    m.gridItems = []

    ' 1. Drive Library Matches
    libCount = m.searchLibraryTv.count() + m.searchLibraryMovies.count()
    if libCount > 0
        h1 = gridContent.CreateChild("ContentNode")
        h1.title = "My Library (" + Stri(libCount).trim() + ")"
        setPosterUrl(h1, "pkg:/images/my-library.jpg")
        h1.shortDescriptionLine1 = "Google Drive Items"
        h1.description = "Found " + Stri(libCount).trim() + " matching item(s) in your Google Drive."
        h1.addFields({ targetType: "section_header" })
        m.gridItems.push(h1)

        ' Sort library TV items by season and episode
        libTvCount = m.searchLibraryTv.count()
        if libTvCount > 1
            for i = 0 to libTvCount - 2
                for j = 0 to libTvCount - i - 2
                    sA = safeInt(m.searchLibraryTv[j].season)
                    sB = safeInt(m.searchLibraryTv[j + 1].season)
                    swap = false
                    if sA > sB
                        swap = true
                    else if sA = sB
                        eA = safeInt(m.searchLibraryTv[j].episode)
                        eB = safeInt(m.searchLibraryTv[j + 1].episode)
                        if eA > eB then swap = true
                    end if
                    if swap
                        tmp = m.searchLibraryTv[j]
                        m.searchLibraryTv[j] = m.searchLibraryTv[j + 1]
                        m.searchLibraryTv[j + 1] = tmp
                    end if
                end for
            end for
        end if

        for each ep in m.searchLibraryTv
            node = gridContent.CreateChild("ContentNode")
            dispTitle = ep.show
            if ep.season <> "" or ep.episode <> ""
                dispTitle = dispTitle + " S" + ep.season + "E" + ep.episode
            end if
            if ep.title <> "" then dispTitle = dispTitle + " - " + ep.title
            node.title = dispTitle
            setPosterUrl(node, resolvePosterUrl(ep.posterUrl, "pkg:/images/tv-shows.jpg"))
            node.shortDescriptionLine1 = "TV Episode · Google Drive"
            node.description = dispTitle
            node.addFields({
                targetType: "drive_episode",
                driveId: ep.driveId,
                mediaPath: ep.mediaPath,
                filename: ep.filename,
                itemTitle: ep.title,
                showName: ep.show,
                seasonNum: ep.season,
                episodeNum: ep.episode,
                posterUrl: ep.posterUrl
            })
            m.gridItems.push(node)
        end for

        for each mv in m.searchLibraryMovies
            node = gridContent.CreateChild("ContentNode")
            node.title = mv.title
            setPosterUrl(node, resolvePosterUrl(mv.posterUrl, "pkg:/images/movies.jpg"))
            node.shortDescriptionLine1 = "Movie · Google Drive"
            node.description = mv.title
            node.addFields({
                targetType: "drive_movie",
                driveId: mv.driveId,
                mediaPath: mv.mediaPath,
                filename: mv.filename,
                itemTitle: mv.title,
                posterUrl: mv.posterUrl
            })
            m.gridItems.push(node)
        end for
    end if

    ' 2. Movie Torrents
    if m.searchMovieTorrents <> invalid and m.searchMovieTorrents.count() > 0
        h2 = gridContent.CreateChild("ContentNode")
        h2.title = "Movie Torrents (" + Stri(m.searchMovieTorrents.count()).trim() + ")"
        setPosterUrl(h2, "pkg:/images/movie-torrents.jpg")
        h2.shortDescriptionLine1 = "Available Movie Torrents"
        h2.description = "Found " + Stri(m.searchMovieTorrents.count()).trim() + " movie torrent(s)."
        h2.addFields({ targetType: "section_header" })
        m.gridItems.push(h2)

        for each t in m.searchMovieTorrents
            node = gridContent.CreateChild("ContentNode")
            tTitle = safeStr(t.title)
            if tTitle = "" then tTitle = "Movie Torrent"
            node.title = tTitle
            pUrl = safeStr(t.poster)
            setPosterUrl(node, resolvePosterUrl(pUrl, "pkg:/images/no-poster.jpg"))
            sCount = safeInt(t.seeds)
            qStr = safeStr(t.quality)
            meta = ""
            if qStr <> "" then meta = qStr + " · "
            meta = meta + Stri(sCount).trim() + " seeds"
            node.shortDescriptionLine1 = meta
            node.description = tTitle + " (" + meta + ")"
            tLink = safeStr(t.link)
            if tLink = "" and t.magnet <> invalid then tLink = safeStr(t.magnet)
            node.addFields({ targetType: "torrent_item", link: tLink, itemTitle: tTitle })
            m.gridItems.push(node)
        end for
    end if

    ' 3. TV Torrents (Filtered & Sorted by Season/Episode)
    if m.searchTvTorrents <> invalid and m.searchTvTorrents.count() > 0
        filteredTvTorrents = []
        latestSearchTv = invalid
        maxSeason = -1
        maxEpisode = -1

        for each t in m.searchTvTorrents
            tTitle = safeStr(t.title)
            ' Hide COMPLETE and season batch torrents
            if isCompleteTorrentBatch(tTitle) then continue for

            epInfo = parseSeasonEpisode(tTitle)
            ' Require episode number
            if epInfo.episode <= 0 then continue for

            filteredTvTorrents.push(t)

            if epInfo.season > maxSeason or (epInfo.season = maxSeason and epInfo.episode > maxEpisode)
                maxSeason = epInfo.season
                maxEpisode = epInfo.episode
                latestSearchTv = t
            else if epInfo.season = maxSeason and epInfo.episode = maxEpisode
                if latestSearchTv = invalid or torrentScore(t) < torrentScore(latestSearchTv)
                    latestSearchTv = t
                end if
            end if
        end for

        if filteredTvTorrents.count() > 0
            sortTvTorrentsBySeasonAndEpisode(filteredTvTorrents)

            h3 = gridContent.CreateChild("ContentNode")
            h3.title = "TV Torrents (" + Stri(filteredTvTorrents.count()).trim() + ")"
            setPosterUrl(h3, "pkg:/images/tv-torrents.jpg")
            h3.shortDescriptionLine1 = "Available TV Torrents"
            h3.description = "Found " + Stri(filteredTvTorrents.count()).trim() + " TV episode torrent(s)."
            h3.addFields({ targetType: "section_header" })
            m.gridItems.push(h3)

            ' Prepend "★ Latest Episode" tile if found
            if latestSearchTv <> invalid and maxSeason > 0 and maxEpisode > 0
                sStr = Right(Stri(100 + maxSeason).trim(), 2)
                eStr = Right(Stri(100 + maxEpisode).trim(), 2)
                lNode = gridContent.CreateChild("ContentNode")
                lNode.title = "★ Latest: S" + sStr + "E" + eStr
                setPosterUrl(lNode, "pkg:/images/star.jpg")
                seeds = safeInt(latestSearchTv.seeds)
                qStr = safeStr(latestSearchTv.quality)
                meta = "Latest Episode"
                if qStr <> "" then meta = meta + " · " + qStr
                meta = meta + " · " + Stri(seeds).trim() + " seeds"
                lNode.shortDescriptionLine1 = meta
                lNode.description = "Quick Play Latest: " + safeStr(latestSearchTv.title)
                tLink = safeStr(latestSearchTv.link)
                if tLink = "" and latestSearchTv.magnet <> invalid then tLink = safeStr(latestSearchTv.magnet)
                lNode.addFields({ targetType: "torrent_item", link: tLink, itemTitle: safeStr(latestSearchTv.title) })
                m.gridItems.push(lNode)
            end if

            for each t in filteredTvTorrents
                node = gridContent.CreateChild("ContentNode")
                tTitle = safeStr(t.title)
                if tTitle = "" then tTitle = "TV Torrent"

                epInfo = parseSeasonEpisode(tTitle)
                if epInfo.season > 0 and epInfo.episode > 0
                    sStr = Right(Stri(100 + epInfo.season).trim(), 2)
                    eStr = Right(Stri(100 + epInfo.episode).trim(), 2)
                    node.title = "S" + sStr + "E" + eStr + " · " + tTitle
                else
                    node.title = tTitle
                end if

                pUrl = safeStr(t.poster)
                setPosterUrl(node, resolvePosterUrl(pUrl, "pkg:/images/no-poster.jpg"))
                sCount = safeInt(t.seeds)
                qStr = safeStr(t.quality)
                meta = ""
                if qStr <> "" then meta = qStr + " · "
                meta = meta + Stri(sCount).trim() + " seeds"
                node.shortDescriptionLine1 = meta
                node.description = tTitle + " (" + meta + ")"
                tLink = safeStr(t.link)
                if tLink = "" and t.magnet <> invalid then tLink = safeStr(t.magnet)
                node.addFields({ targetType: "torrent_item", link: tLink, itemTitle: tTitle })
                m.gridItems.push(node)
            end for
        end if
    end if

    ' 4. Free TV Channels
    if m.searchChannels <> invalid and m.searchChannels.count() > 0
        h4 = gridContent.CreateChild("ContentNode")
        h4.title = "Free TV Channels (" + Stri(m.searchChannels.count()).trim() + ")"
        setPosterUrl(h4, "pkg:/images/live.jpg")
        h4.shortDescriptionLine1 = "Live FAST Channels"
        h4.description = "Found " + Stri(m.searchChannels.count()).trim() + " matching channel(s)."
        h4.addFields({ targetType: "section_header" })
        m.gridItems.push(h4)

        for each ch in m.searchChannels
            node = gridContent.CreateChild("ContentNode")
            cName = safeStr(ch.name)
            node.title = cName
            pUrl = safeStr(ch.logo)
            setPosterUrl(node, resolvePosterUrl(pUrl, "pkg:/images/live.jpg"))
            node.shortDescriptionLine1 = safeStr(ch.provider) + " · " + safeStr(ch.category)
            node.description = cName + " (" + safeStr(ch.provider) + ")"
            node.addFields({ targetType: "freetv_channel", streamUrl: safeStr(ch.streamUrl), itemTitle: cName })
            m.gridItems.push(node)
        end for
    end if

    ' 5. Popular / Fresh titles
    if m.searchWhatson <> invalid and m.searchWhatson.count() > 0
        h5 = gridContent.CreateChild("ContentNode")
        h5.title = "Popular Titles (" + Stri(m.searchWhatson.count()).trim() + ")"
        setPosterUrl(h5, "pkg:/images/fresh.jpg")
        h5.shortDescriptionLine1 = "Popular & Streaming"
        h5.description = "Found " + Stri(m.searchWhatson.count()).trim() + " popular title(s)."
        h5.addFields({ targetType: "section_header" })
        m.gridItems.push(h5)

        for each item in m.searchWhatson
            node = gridContent.CreateChild("ContentNode")
            wTitle = safeStr(item.title)
            node.title = wTitle
            pUrl = safeStr(item.poster)
            if pUrl = "" and item.image <> invalid then pUrl = safeStr(item.image)
            setPosterUrl(node, resolvePosterUrl(pUrl, "pkg:/images/no-poster.jpg"))
            node.shortDescriptionLine1 = safeStr(item.type)
            node.description = wTitle
            node.addFields({ targetType: "popular_item", itemTitle: wTitle, itemType: safeStr(item.type) })
            m.gridItems.push(node)
        end for
    end if

    ' Update breadcrumb text
    if m.gridItems.count() = 0
        if m.searchTasksPending > 0
            m.folderBreadcrumb.text = "Searching online streams for '" + m.lastSearchQuery + "'..."
        else
            m.folderBreadcrumb.text = "No results found for '" + m.lastSearchQuery + "'"
        end if
    else
        extra = ""
        if m.searchTasksPending > 0 then extra = " (Searching streams...)"
        m.folderBreadcrumb.text = "Search: '" + m.lastSearchQuery + "' (" + Stri(m.gridItems.count()).trim() + " items)" + extra
    end if

    m.posterGrid.content = gridContent
    if m.gridItems.count() > 0 and m.posterGrid.itemFocused < 0
        m.posterGrid.jumpToItem = 0
    end if
    m.posterGrid.setFocus(true)
end sub

sub onDialogClosed()
end sub

sub setPosterUrl(node as Object, posterUrl as String)
    node.HDPosterUrl = posterUrl
    node.hdPosterUrl = posterUrl
    node.SDPosterUrl = posterUrl
    node.sdPosterUrl = posterUrl
end sub

function resolvePosterUrl(poster as Dynamic, fallbackIcon as String) as String
    if poster = invalid return fallbackIcon
    pStr = safeStr(poster)
    if pStr = "" return fallbackIcon
    if LCase(pStr).left(4) = "http"
        return pStr
    else if pStr.left(1) = "/"
        url = m.serverUrl + pStr
        if Instr(1, pStr, "/api/whatson/poster") > 0 and Instr(1, pStr, "thumb=1") = 0
            if Instr(1, pStr, "?") > 0
                url = url + "&thumb=1"
            else
                url = url + "?thumb=1"
            end if
        end if
        return url
    else
        return m.serverUrl + "/api/media/poster?path=" + encodePath(pStr) + "&thumb=1"
    end if
end function

function formatDurationStr(duration as Dynamic) as String
    if duration = invalid or duration = 0 return ""
    totalSecs = Fix(duration)
    mins = Fix(totalSecs / 60)
    if mins > 60
        hrs = Fix(mins / 60)
        remMins = mins mod 60
        return Stri(hrs).trim() + "h " + Stri(remMins).trim() + "m"
    end if
    return Stri(mins).trim() + "m"
end function

function safeStr(v as Dynamic) as String
    if v = invalid return ""
    s = v.toStr()
    if s = invalid return ""
    return s
end function

function safeInt(v as Dynamic) as Integer
    if v = invalid return 0
    s = safeStr(v)
    if s = "" return 0
    return Val(s)
end function

function encodePath(p as Dynamic) as String
    if p = invalid return ""
    strP = p.toStr()
    if strP = "" return ""
    ut = CreateObject("roUrlTransfer")
    if ut <> invalid
        return ut.UrlEncode(strP)
    end if

    result = ""
    for i = 0 to len(strP) - 1
        c = mid(strP, i + 1, 1)
        a = asc(c)
        if c = "\"
            result = result + "%5C"
        else if c = " "
            result = result + "%20"
        else if c = ":"
            result = result + "%3A"
        else if c = "#"
            result = result + "%23"
        else if c = "&"
            result = result + "%26"
        else if c = "+"
            result = result + "%2B"
        else if c = "?"
            result = result + "%3F"
        else if c = "%"
            result = result + "%25"
        else if c = "="
            result = result + "%3D"
        else if c = "("
            result = result + "%28"
        else if c = ")"
            result = result + "%29"
        else if c = "["
            result = result + "%5B"
        else if c = "]"
            result = result + "%5D"
        else if c = "{"
            result = result + "%7B"
        else if c = "}"
            result = result + "%7D"
        else if c = "'"
            result = result + "%27"
        else if a = 34
            result = result + "%22"
        else
            result = result + c
        end if
    end for
    return result
end function

' Prefer 720p (and smaller) torrents. Lower tier = more preferred.
function getResolutionTier(str as Dynamic) as Integer
    s = LCase(safeStr(str))
    if Instr(1, s, "2160") > 0 or Instr(1, s, "4k") > 0 or Instr(1, s, "uhd") > 0 or Instr(1, s, "8k") > 0
        return 2
    end if
    if Instr(1, s, "1080") > 0 or Instr(1, s, "fhd") > 0
        return 1
    end if
    if Instr(1, s, "720") > 0 or Instr(1, s, "480") > 0 or Instr(1, s, "576") > 0 or Instr(1, s, "hdtv") > 0 or Instr(1, s, "webrip") > 0 or Instr(1, s, "web-dl") > 0
        return 0
    end if
    return 1
end function

' Rank torrents: resolution dominates, then seed/peer count breaks ties.
function torrentScore(r as Object) as Integer
    titleStr = safeStr(r.title)
    qualityStr = safeStr(r.quality)
    tier = getResolutionTier(titleStr + " " + qualityStr)
    seeds = safeInt(r.seeds)
    peers = safeInt(r.peers)
    return tier * 100000 - (seeds * 2 + peers)
end function

' Bubble-sort a torrent list so 720p (preferred) results come first.
sub sortTorrentsByScore(list as Object)
    n = list.count()
    for i = 0 to n - 2
        for j = 0 to n - i - 2
            if torrentScore(list[j]) > torrentScore(list[j + 1])
                tmp = list[j]
                list[j] = list[j + 1]
                list[j + 1] = tmp
            end if
        end for
    end for
end sub

' Check if a torrent title represents a complete series/season batch pack
function isCompleteTorrentBatch(title as String) as Boolean
    if title = "" return false
    uTitle = UCase(title)

    ' 1. Check for "COMPLETE" keyword
    if Instr(1, uTitle, "COMPLETE") > 0 return true

    ' 2. Check for "SEASON PACK" or "SEASON.PACK" or "BOXSET"
    if Instr(1, uTitle, "SEASON PACK") > 0 or Instr(1, uTitle, "SEASON.PACK") > 0 or Instr(1, uTitle, "BOXSET") > 0 return true

    ' 3. Check for season range pattern: S01-S04, S1-S3, S01-04, etc.
    rRange = CreateObject("roRegex", "[sS]\d{1,2}\s*-\s*[sS]?\d{1,2}", "")
    if rRange.IsMatch(uTitle) return true

    ' 4. Check for episode range pattern: E01-E10, E01-10
    rEpRange = CreateObject("roRegex", "[eE]\d{1,2}\s*-\s*[eE]?\d{1,2}", "")
    if rEpRange.IsMatch(uTitle) return true

    return false
end function

' Robust season and episode parser from torrent or file title
function parseSeasonEpisode(title as String) as Object
    res = { season: 0, episode: 0, found: false }
    if title = "" return res

    ' Pattern 1: S01E02 or s1e2 or S01.E02 or S01_E02
    r1 = CreateObject("roRegex", "[sS](\d{1,2})[\. _-]?[eE](\d{1,2})", "")
    m1 = r1.Match(title)
    if m1.count() >= 3
        res.season = Val(m1[1])
        res.episode = Val(m1[2])
        res.found = true
        return res
    end if

    ' Pattern 2: 1x02 or 01x02
    r2 = CreateObject("roRegex", "\b(\d{1,2})x(\d{1,2})\b", "i")
    m2 = r2.Match(title)
    if m2.count() >= 3
        res.season = Val(m2[1])
        res.episode = Val(m2[2])
        res.found = true
        return res
    end if

    ' Pattern 3: Season 1 or S01
    r3 = CreateObject("roRegex", "(?:season|[\. _\[-]s)\.?\s*(\d{1,2})", "i")
    m3 = r3.Match(title)
    if m3.count() >= 2
        res.season = Val(m3[1])
        res.found = true
    end if

    ' Pattern 4: Episode 1 or E01
    r4 = CreateObject("roRegex", "(?:episode|[\. _\[-]e)\.?\s*(\d{1,2})", "i")
    m4 = r4.Match(title)
    if m4.count() >= 2
        res.episode = Val(m4[1])
        res.found = true
    end if

    return res
end function

' Sort a list of TV torrents by Episode number ascending, then by torrentScore
sub sortTvTorrentsByEpisode(list as Object)
    n = list.count()
    if n <= 1 return
    for i = 0 to n - 2
        for j = 0 to n - i - 2
            epA = parseSeasonEpisode(safeStr(list[j].title)).episode
            epB = parseSeasonEpisode(safeStr(list[j + 1].title)).episode
            swap = false
            if epA > epB
                swap = true
            else if epA = epB
                if torrentScore(list[j]) > torrentScore(list[j + 1])
                    swap = true
                end if
            end if
            if swap
                tmp = list[j]
                list[j] = list[j + 1]
                list[j + 1] = tmp
            end if
        end for
    end for
end sub

' Sort a list of TV torrents by Season ascending, then Episode ascending, then torrentScore
sub sortTvTorrentsBySeasonAndEpisode(list as Object)
    n = list.count()
    if n <= 1 return
    for i = 0 to n - 2
        for j = 0 to n - i - 2
            infoA = parseSeasonEpisode(safeStr(list[j].title))
            infoB = parseSeasonEpisode(safeStr(list[j + 1].title))
            swap = false
            if infoA.season > infoB.season
                swap = true
            else if infoA.season = infoB.season
                if infoA.episode > infoB.episode
                    swap = true
                else if infoA.episode = infoB.episode
                    if torrentScore(list[j]) > torrentScore(list[j + 1])
                        swap = true
                    end if
                end if
            end if
            if swap
                tmp = list[j]
                list[j] = list[j + 1]
                list[j + 1] = tmp
            end if
        end for
    end for
end sub

sub closeGamePlayerScreen()
    if m.gamePlayerGroup <> invalid
        m.top.removeChild(m.gamePlayerGroup)
        m.gamePlayerGroup = invalid
    end if
    if m.posterGrid <> invalid then m.posterGrid.visible = true
end sub
