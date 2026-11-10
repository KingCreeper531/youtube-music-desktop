# Generates build/icon.png (256px) and build/icon.ico (multi-size, PNG-compressed).
# Red disc, white ring, white play triangle. Geometry is defined on a 960px grid.
param([string]$OutDir = (Join-Path $PSScriptRoot '..\build'))
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $size / 960.0

  # Red disc filling the canvas
  $red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 0, 0))
  $g.FillEllipse($red, 0, 0, $size, $size)

  # White ring: outer radius 250, 21 thick, centred at 480,480
  $ringWidth = [Math]::Max(21 * $k, 1.0)
  $r = (250 - 10.5) * $k
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), $ringWidth
  $c = 480 * $k
  $g.DrawEllipse($pen, [single]($c - $r), [single]($c - $r), [single](2 * $r), [single](2 * $r))

  # Play triangle
  $pts = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF (393 * $k), (355 * $k)),
    (New-Object System.Drawing.PointF (393 * $k), (605 * $k)),
    (New-Object System.Drawing.PointF (605 * $k), (480 * $k))
  )
  $g.FillPolygon([System.Drawing.Brushes]::White, $pts)
  $g.Dispose()
  return $bmp
}

$sizes = 256, 64, 48, 32, 24, 16
$pngs = @{}
foreach ($sz in $sizes) {
  $bmp = New-IconBitmap $sz
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs[$sz] = $ms.ToArray()
  if ($sz -eq 256) { $bmp.Save((Join-Path $OutDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
  $bmp.Dispose()
}

# ICO container: header + directory + PNG payloads
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($sz in $sizes) {
  $dim = if ($sz -ge 256) { 0 } else { $sz }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$pngs[$sz].Length); $w.Write([UInt32]$offset)
  $offset += $pngs[$sz].Length
}
foreach ($sz in $sizes) { $w.Write($pngs[$sz]) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $OutDir 'icon.ico'), $out.ToArray())
"Wrote icon.png and icon.ico to $OutDir"
