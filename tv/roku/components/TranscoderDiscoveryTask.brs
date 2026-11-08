sub init()
    m.top.functionName = "runDiscovery"
end sub

sub runDiscovery()
    m.top.status = "searching"
    serverUrl = m.top.serverUrl
    if serverUrl = invalid or serverUrl = ""
        serverUrl = "https://tv.butfree.online"
    end if

    ' Step 1: Check cached local transcoder URL from registry
    cached = m.top.cachedUrl
    if cached <> invalid and cached <> ""
        cleanCached = cleanBaseUrl(cached)
        if verifyTranscoderHealth(cleanCached)
            print "[Transcoder Discovery] Cached URL alive: " + cleanCached
            m.top.discoveredUrl = cleanCached
            m.top.status = "connected"
            return
        end if
    end if

    ' Step 2: Instant LAN / Localhost / Dev Checks
    localCandidates = ["http://192.168.0.21:4300", "http://192.168.0.15:4300", "http://127.0.0.1:4300", "http://localhost:4300"]
    for each cand in localCandidates
        if verifyTranscoderHealth(cand)
            print "[Transcoder Discovery] Found local instance: " + cand
            m.top.discoveredUrl = cand
            m.top.status = "connected"
            return
        end if
    end for

    ' Step 3: Check Roku's own network interface IPs on port 4300 (covers bridged simulators & host interfaces)
    di = CreateObject("roDeviceInfo")
    myIps = []
    if di <> invalid
        ipAddrs = di.GetIPAddrs()
        if ipAddrs <> invalid
            for each iface in ipAddrs
                candIp = ipAddrs[iface]
                if candIp <> invalid and candIp <> "" and Left(candIp, 7) <> "169.254"
                    myIps.push(candIp)
                    candUrl = "http://" + candIp + ":4300"
                    if verifyTranscoderHealth(candUrl)
                        print "[Transcoder Discovery] Found on host interface IP: " + candUrl
                        m.top.discoveredUrl = candUrl
                        m.top.status = "connected"
                        return
                    end if
                end if
            end for
        end if
    end if

    ' Step 4: Query Cloud Server for registered local LAN IP(s) of this network
    cloudUrl = serverUrl + "/api/transcoder/discover"
    authToken = m.top.authToken
    if authToken <> invalid and authToken <> ""
        cloudUrl = cloudUrl + "?token=" + authToken
    end if

    cloudResp = httpGet(cloudUrl, 2000)
    if cloudResp <> invalid and cloudResp <> ""
        json = ParseJson(cloudResp)
        if json <> invalid and json.found = true and json.localIps <> invalid
            portStr = "4300"
            if json.port <> invalid then portStr = Stri(json.port).trim()
            for each ip in json.localIps
                candUrl = "http://" + ip + ":" + portStr
                if verifyTranscoderHealth(candUrl)
                    print "[Transcoder Discovery] Cloud matched LAN IP: " + candUrl
                    m.top.discoveredUrl = candUrl
                    m.top.status = "connected"
                    return
                end if
            end for
        end if
    end if

    ' Step 5: SSDP M-SEARCH broadcast over local network (UDP 1900)
    ssdpFound = trySsdpDiscovery()
    if ssdpFound <> ""
        print "[Transcoder Discovery] SSDP found: " + ssdpFound
        m.top.discoveredUrl = ssdpFound
        m.top.status = "connected"
        return
    end if

    ' Step 6: Subnet probe of Roku's local IP network on port 4300
    subnetFound = trySubnetProbe(myIps)
    if subnetFound <> ""
        print "[Transcoder Discovery] Subnet probe found: " + subnetFound
        m.top.discoveredUrl = subnetFound
        m.top.status = "connected"
        return
    end if

    print "[Transcoder Discovery] No local tv-transcoder found on network."
    m.top.status = "not_found"
end sub

function cleanBaseUrl(url as String) as String
    u = url.trim()
    while Len(u) > 0 and Right(u, 1) = "/"
        u = Left(u, Len(u) - 1)
    end while
    return u
end function

function httpGet(url as String, timeoutMs as Integer) as String
    try
        http = CreateObject("roUrlTransfer")
        if http = invalid return ""
        if Left(url, 5) = "https"
            http.SetCertificatesFile("common:/certs/ca-bundle.crt")
            http.InitClientCertificates()
        end if
        http.setUrl(url)
        port = CreateObject("roMessagePort")
        http.SetMessagePort(port)
        http.AsyncGetToString()

        timer = CreateObject("roTimespan")
        timer.mark()
        while timer.totalMilliseconds() < timeoutMs
            event = wait(100, port)
            if type(event) = "roUrlEvent"
                if event.GetResponseCode() = 200
                    return event.GetString()
                end if
                return ""
            end if
        end while
        http.AsyncCancel()
    catch e
    end try
    return ""
end function

function verifyTranscoderHealth(baseUrl as String) as Boolean
    if baseUrl = invalid or baseUrl = "" or Left(baseUrl, 4) <> "http" return false
    clean = cleanBaseUrl(baseUrl)
    resp = httpGet(clean + "/api/health", 800)
    if resp <> ""
        json = ParseJson(resp)
        if json <> invalid and (json.ok = true or json.name = "tv-transcoder")
            return true
        end if
    end if
    return false
end function

function trySsdpDiscovery() as String
    try
        port = CreateObject("roMessagePort")
        if port = invalid return ""
        udp = CreateObject("roDatagramSocket")
        if udp = invalid return ""

        sockAddr = CreateObject("roSocketAddress")
        if sockAddr = invalid return ""
        sockAddr.setHostName("239.255.255.250")
        sockAddr.setPort(1900)

        udp.setMessagePort(port)
        udp.setSendToAddress(sockAddr)
        udp.notifyReadable(true)

        msg = "M-SEARCH * HTTP/1.1" + Chr(13) + Chr(10)
        msg = msg + "HOST: 239.255.255.250:1900" + Chr(13) + Chr(10)
        msg = msg + "MAN: ""ssdp:discover""" + Chr(13) + Chr(10)
        msg = msg + "MX: 1" + Chr(13) + Chr(10)
        msg = msg + "ST: urn:butfree:tv-transcoder:1" + Chr(13) + Chr(10)
        msg = msg + Chr(13) + Chr(10)

        udp.sendStr(msg)

        timer = CreateObject("roTimespan")
        timer.mark()
        while timer.totalMilliseconds() < 1200
            msgEvent = wait(150, port)
            if type(msgEvent) = "roSocketEvent"
                if udp.isReadable()
                    resp = udp.receiveStr(2048)
                    if resp <> invalid and resp <> ""
                        locIdx = Instr(1, UCase(resp), "LOCATION:")
                        if locIdx > 0
                            lineEnd = Instr(locIdx, resp, Chr(13))
                            if lineEnd = 0 then lineEnd = Instr(locIdx, resp, Chr(10))
                            if lineEnd = 0 then lineEnd = Len(resp) + 1
                            locLine = Mid(resp, locIdx + 9, lineEnd - (locIdx + 9)).trim()
                            qIdx = Instr(1, locLine, "/api")
                            if qIdx > 0
                                baseUrl = Left(locLine, qIdx - 1)
                            else
                                baseUrl = locLine
                            end if
                            if Left(baseUrl, 4) = "http"
                                if verifyTranscoderHealth(baseUrl)
                                    return cleanBaseUrl(baseUrl)
                                end if
                            end if
                        end if
                    end if
                end if
            end if
        end while
    catch e
        print "[Transcoder SSDP] Notice: " + e.message
    end try
    return ""
end function

function trySubnetProbe(myIps as Object) as String
    try
        prefixes = []
        myLastOctet = -1

        if myIps <> invalid and myIps.count() > 0
            for each ip in myIps
                if ip <> "127.0.0.1" and Left(ip, 7) <> "169.254"
                    tokens = ip.split(".")
                    if tokens.count() = 4
                        p = tokens[0] + "." + tokens[1] + "." + tokens[2] + "."
                        prefixes.push(p)
                        myLastOctet = Val(tokens[3])
                    end if
                end if
            end for
        end if

        ' Common default fallback subnets if device didn't report a LAN interface
        if prefixes.count() = 0
            prefixes = ["192.168.0.", "192.168.1.", "10.0.0."]
        end if

        ' Priority candidates: Server PC (.21), common router/server static IPs
        priorityOctets = [15, 21, 20, 22, 2, 3, 4, 5, 10, 25, 30, 40, 50, 100, 101, 102, 105, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 1]

        ' Also add neighbors around my own IP
        if myLastOctet > 0
            for offset = -4 to 4
                target = myLastOctet + offset
                if target >= 1 and target <= 254
                    priorityOctets.push(target)
                end if
            end for
        end if

        ' Test candidates
        tested = {}
        for each prefix in prefixes
            for each octet in priorityOctets
                key = prefix + Stri(octet).trim()
                if not tested.DoesExist(key)
                    tested[key] = true
                    candUrl = "http://" + key + ":4300"
                    if verifyTranscoderHealth(candUrl)
                        return candUrl
                    end if
                end if
            end for
        end for
    catch e
        print "[Transcoder Subnet Probe] Notice: " + e.message
    end try
    return ""
end function
