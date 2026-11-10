# Generates the iPhone app icon: 1024x1024, no transparency (iOS rounds the corners itself).
# Same design as the desktop icon, drawn edge to edge.
param([string]$Out = (Join-Path $PSScriptRoot '..\ios\Resources\Assets.xcassets\AppIcon.appiconset\AppIcon-1024.png'))
Add-Type -AssemblyName System.Drawing
$size = 1024
$bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.PixelOffsetMode = 'HighQuality'
$g.Clear([System.Drawing.Color]::FromArgb(255, 255, 0, 0))
$k = $size / 960.0

# White ring: outer radius 250, 21 thick, centred (960px design grid)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([single](21 * $k))
$c = 480 * $k
$r = (250 - 10.5) * $k
$g.DrawEllipse($pen, [single]($c - $r), [single]($c - $r), [single](2 * $r), [single](2 * $r))

# Play triangle
$pts = [System.Drawing.PointF[]]@(
  (New-Object System.Drawing.PointF (393 * $k), (355 * $k)),
  (New-Object System.Drawing.PointF (393 * $k), (605 * $k)),
  (New-Object System.Drawing.PointF (605 * $k), (480 * $k))
)
$g.FillPolygon([System.Drawing.Brushes]::White, $pts)
$g.Dispose()
New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"Wrote $Out"
