sub Main()
    screen = CreateObject("roSGScreen")
    m.port = CreateObject("roMessagePort")
    screen.SetMessagePort(m.port)
    scene = screen.CreateScene("MainScene")
    screen.Show()

    while true
        msg = wait(0, m.port)
        msgType = type(msg)
        if msgType = "roSGScreenEvent"
            if msg.IsScreenClosed()
                stopAllTranscodingOnExit()
                return
            end if
        end if
    end while
end sub

sub stopAllTranscodingOnExit()
    reg = CreateObject("roRegistrySection", "FREEVEE")
    url = ""
    if reg.Exists("localTranscoderUrl") then url = reg.Read("localTranscoderUrl")
    if url = "" then url = "http://192.168.0.15:4300"
    if url <> ""
        http = CreateObject("roUrlTransfer")
        if http <> invalid
            http.setUrl(url + "/api/stream/drive-hls/stop")
            http.AddHeader("Content-Type", "application/json")
            port = CreateObject("roMessagePort")
            http.SetMessagePort(port)
            http.AsyncPostFromString(FormatJson({ clearAll: true }))
            wait(200, port)
        end if
    end if
end sub
