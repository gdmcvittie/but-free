sub init()
    m.top.functionName = "run"
end sub

sub run()
    url = m.top.url
    if url = ""
        m.top.error = "no url"
        return
    end if

    authToken = m.top.authToken
    if authToken <> "" and authToken <> invalid
        if Instr(1, url, "token=") = 0
            if Instr(1, url, "?") > 0
                url = url + "&token=" + authToken
            else
                url = url + "?token=" + authToken
            end if
        end if
    end if

    http = CreateObject("roUrlTransfer")
    http.SetCertificatesFile("common:/certs/ca-bundle.crt")
    http.InitClientCertificates()
    http.setUrl(url)
    port = CreateObject("roMessagePort")
    http.SetMessagePort(port)

    if authToken <> "" and authToken <> invalid
        http.AddHeader("Authorization", "Bearer " + authToken)
        http.AddHeader("X-Auth-Token", authToken)
    end if

    method = m.top.method
    if method = "POST"
        postData = m.top.postData
        if postData <> ""
            http.AddHeader("Content-Type", "application/json")
        end if
        http.AsyncPostFromString(postData)
    else
        http.AsyncGetToString()
    end if

    timeout = 30000
    if m.top.timeoutMs <> invalid and m.top.timeoutMs > 0
        timeout = m.top.timeoutMs
    end if

    msg = wait(timeout, port)
    if type(msg) = "roUrlEvent"
        code = msg.GetResponseCode()
        if code = 200 or code = 201 or code = 204
            response = msg.GetString()
            if response <> invalid
                m.top.result = response
            else
                m.top.result = "{}"
            end if
        else
            m.top.error = "HTTP " + Stri(code).trim()
        end if
    else
        m.top.error = "timeout"
    end if
end sub
