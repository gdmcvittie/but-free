$client = New-Object System.Net.Sockets.TcpClient
$client.Connect('192.168.0.3', 8085)
$stream = $client.GetStream()
$reader = New-Object System.IO.StreamReader($stream)
while ($true) {
    $line = $reader.ReadLine()
    if ($line -eq $null) { break }
    Write-Output $line
}

