sub init()
    m.top.functionName = "run"
end sub

sub run()
    url = m.top.url
    if url = ""
        m.top.error = "no url"
        return
    end if
    http = CreateObject("roUrlTransfer")
    http.SetCertificatesFile("common:/certs/ca-bundle.crt")
    http.InitClientCertificates()
    http.setUrl(url)
    port = CreateObject("roMessagePort")
    http.SetMessagePort(port)

    authToken = m.top.authToken
    if authToken <> "" and authToken <> invalid
        http.AddHeader("Authorization", "Bearer " + authToken)
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
        if code = 200
            response = msg.GetString()
            if response <> invalid and response <> ""
                m.top.result = response
            else
                m.top.error = "empty body"
            end if
        else
            m.top.error = "HTTP " + Stri(code).trim()
        end if
    else
        m.top.error = "timeout"
    end if
end sub
