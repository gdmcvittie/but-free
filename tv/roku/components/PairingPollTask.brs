sub init()
    m.top.functionName = "run"
end sub

sub run()
    serverUrl = m.top.serverUrl
    code = m.top.code
    if serverUrl = "" or code = ""
        m.top.result = FormatJson({ status: "error", error: "Missing server URL or code" })
        return
    end if

    ' Poll for up to ~6 minutes (matches the 5-minute server-side expiry)
    pollStart = CreateObject("roDateTime").asSeconds()
    timeoutSecs = 300

    while true
        nowSecs = CreateObject("roDateTime").asSeconds()
        if nowSecs - pollStart > timeoutSecs
            m.top.result = FormatJson({ status: "expired" })
            return
        end if

        statusUrl = serverUrl + "/auth/device/status/" + code
        statusResult = doGet(statusUrl)
        if statusResult.error = ""
            statusJson = ParseJSON(statusResult.body)
            if statusJson <> invalid and statusJson.status <> invalid
                if statusJson.status = "complete"
                    ' Older server versions return the token inline in the status
                    if statusJson.token <> invalid and statusJson.token <> ""
                        m.top.result = FormatJson({ status: "complete", token: statusJson.token })
                        return
                    end if
                    ' Newer server versions require a separate token fetch
                    tokenResult = doGet(serverUrl + "/auth/device/token/" + code)
                    if tokenResult.error = ""
                        tokenJson = ParseJSON(tokenResult.body)
                        if tokenJson <> invalid and tokenJson.success = true and tokenJson.token <> invalid and tokenJson.token <> ""
                            m.top.result = FormatJson({ status: "complete", token: tokenJson.token })
                            return
                        else
                            m.top.result = FormatJson({ status: "error", error: "token_fetch_failed" })
                            return
                        end if
                    else
                        m.top.result = FormatJson({ status: "error", error: "token_fetch_error" })
                        return
                    end if
                else if statusJson.status = "expired"
                    m.top.result = FormatJson({ status: "expired" })
                    return
                end if
                ' status = pending -> keep polling
            end if
        end if

        ' Wait 2 seconds between polls
        sleep(2000)
    end while
end sub

function doGet(url as String) as Object
    http = CreateObject("roUrlTransfer")
    http.SetCertificatesFile("common:/certs/ca-bundle.crt")
    http.InitClientCertificates()
    http.setUrl(url)
    port = CreateObject("roMessagePort")
    http.SetMessagePort(port)
    if http.AsyncGetToString()
        msg = wait(15000, port)
        if type(msg) = "roUrlEvent"
            code = msg.GetResponseCode()
            if code = 200
                return { body: msg.GetString(), error: "" }
            else
                return { body: "", error: "HTTP " + Stri(code).trim() }
            end if
        end if
    end if
    return { body: "", error: "timeout" }
end function