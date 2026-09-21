# Draws host\frontdesk.ico, the icon the exe carries.
#
#   pwsh -File tools/make-icon.ps1
#   pwsh -File tools/make-icon.ps1 -Text F -FontScale 0.62   # try a variant
#
# Why this is a script and not a checked-in PNG someone resized: there is no
# image tooling on this machine (no ImageMagick, no Inkscape, no Windows SDK),
# so an .ico has to be produced with what ships with Windows -- System.Drawing.
# Generating it means the icon is reproducible from source like everything else
# here, and it can be redrawn at any size rather than upscaled from a bitmap.
#
# The design is the app's own mark, not a new one: a magenta tile with "FD" in
# white, the same thing FrontDesk.cs:MakeIcon() draws for the tray. It is drawn
# here at seven sizes instead of one, because Windows picks a different size for
# the taskbar, the Alt-Tab switcher, Explorer's small and large views, and the
# 256px tile view -- and a single 32px bitmap scaled up to 256 looks like a
# mistake.
#
# The Rotman wordmark in web/index.html (window.__ROT_LOGO) is deliberately NOT
# the icon: it is a 190x69 horizontal wordmark drawn in white for the dark
# header. Squeezed into a square it would be a few pixels of unreadable text,
# and an official university mark inside a rounded app tile is a branding
# decision rather than a technical one.
#
# The entries are written as classic 32-bit DIBs with an AND mask rather than
# PNG-compressed entries. PNG entries are smaller and Windows Vista and later
# render them happily, but System.Drawing.Icon -- which is what any .NET code
# that loads this file uses -- does not parse them and throws. DIB works
# everywhere, and 256px of flat magenta compresses to nothing in a zip anyway.

[CmdletBinding()]
param(
    # The glyph on the tile.
    [string] $Text = 'FD',

    # Glyph size as a fraction of the tile, and extra space between glyphs as a
    # fraction of the glyph size. Both were chosen by rendering the 16px frame at
    # 12x and comparing: the scale alone could not both keep the strokes heavy
    # enough to survive at 16px and keep F from merging into D, and the tracking
    # is what resolves that. Zero tracking is the font's own spacing.
    [double] $FontScale = 0.50,

    [double] $Tracking = 0.08,

    # Corner radius as a fraction of the tile.
    [double] $RadiusScale = 0.21,

    # Where to write it. Defaults to host\frontdesk.ico, which is what
    # host\build.ps1 passes to csc with /win32icon.
    [string] $OutFile = (Join-Path (Split-Path -Parent $PSScriptRoot) 'host\frontdesk.ico')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# The Rotman magenta, and a darker one of the same hue for the gradient. The
# darker end is the value the light theme uses for text, so the two agree.
$magentaTop = [System.Drawing.ColorTranslator]::FromHtml('#E6007E')
$magentaBottom = [System.Drawing.ColorTranslator]::FromHtml('#A8005A')

$sizes = 16, 24, 32, 48, 64, 128, 256

# A rounded rectangle as a GraphicsPath. System.Drawing has no helper for this,
# so it is four arcs joined by lines.
function New-RoundedRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    if ($r -le 0) { $p.AddRectangle((New-Object System.Drawing.RectangleF -ArgumentList $x, $y, $w, $h)); return $p }
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# One size of the icon, as a freshly drawn bitmap.
function New-TileBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        # Hinted text at the sizes Windows renders as text-like UI, plain
        # antialiasing above that where there is room for the smoother shapes.
        if ($size -le 48) {
            $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        } else {
            $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
        }
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.Clear([System.Drawing.Color]::Transparent)

        # Inset by half a pixel at the small sizes so the antialiased edge of the
        # tile has somewhere to land instead of being clipped by the bitmap edge.
        $inset = if ($size -le 32) { 0.5 } else { 0.0 }
        $box = $size - ($inset * 2)
        $radius = [single]([Math]::Max(2.0, $box * $RadiusScale))

        $path = New-RoundedRect $inset $inset $box $box $radius
        $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            (New-Object System.Drawing.PointF(0, 0)),
            (New-Object System.Drawing.PointF($size, $size)),
            $magentaTop, $magentaBottom)
        $g.FillPath($brush, $path)

        # A hairline of light along the top edge. Reads as a bevel at 48px and up
        # and as nothing at all below that, which is the point.
        if ($size -ge 48) {
            $rim = [System.Drawing.Color]::FromArgb(60, 255, 255, 255)
            $rimWidth = [single]([Math]::Max(1.0, $size / 48))
            $pen = New-Object System.Drawing.Pen -ArgumentList $rim, $rimWidth
            $g.DrawPath($pen, $path)
            $pen.Dispose()
        }

        # The glyph. Measured and then centred by hand rather than drawn into a
        # centred StringFormat: MeasureString pads its result, and the padding is
        # a much bigger fraction of a 16px tile than of a 256px one, so letting
        # the format do the centring makes the small sizes sit visibly high.
        #
        # Each character is placed by hand for the same reason it is worth doing:
        # at 16px a single DrawString has to choose between "FD" light enough to
        # leave the tile a margin and heavy enough for the letters to stay apart,
        # and it cannot do both. Placing them individually breaks that tie --
        # the glyphs keep the weight that makes them readable and the tracking
        # keeps them from merging.
        if ($Text) {
            $px = [single]([Math]::Max(6.0, $box * $FontScale))
            $font = New-Object System.Drawing.Font('Segoe UI', $px, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
            $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
            # GenericTypographic measures the actual glyphs; the default format
            # adds padding meant for laying out paragraphs.
            $measure = [System.Drawing.StringFormat]::GenericTypographic
            $chars = $Text.ToCharArray()

            $widths = @()
            $total = 0.0
            foreach ($ch in $chars) {
                $wch = $g.MeasureString([string]$ch, $font, (New-Object System.Drawing.PointF(0, 0)), $measure).Width
                $widths += $wch
                $total += $wch
            }
            $trackPx = $px * $Tracking
            $total += $trackPx * ($chars.Count - 1)

            $sz = $g.MeasureString($Text, $font, (New-Object System.Drawing.PointF(0, 0)), $measure)
            $x = ($size - $total) / 2.0
            $y = ($size - $sz.Height) / 2.0 + ($sz.Height * 0.06)
            for ($ci = 0; $ci -lt $chars.Count; $ci++) {
                $g.DrawString([string]$chars[$ci], $font, $white, [single]$x, [single]$y, $measure)
                $x += $widths[$ci] + $trackPx
            }
            $white.Dispose()
            $font.Dispose()
        }

        $brush.Dispose()
        $path.Dispose()
    } finally {
        $g.Dispose()
    }
    return $bmp
}

# A bitmap as one ICO image entry: BITMAPINFOHEADER + bottom-up BGRA + AND mask.
function ConvertTo-IconDib([System.Drawing.Bitmap]$bmp) {
    $size = $bmp.Width
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $stride = $data.Stride
        $scan0 = $data.Scan0
        $pixels = New-Object byte[] ($stride * $size)
        [System.Runtime.InteropServices.Marshal]::Copy($scan0, $pixels, 0, $pixels.Length)
    } finally {
        $bmp.UnlockBits($data)
    }

    # BITMAPINFOHEADER, 40 bytes. Height is doubled: a DIB in an ICO is stored
    # as the colour image stacked on the AND mask, and the header describes both.
    $ms = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter($ms)
    try {
        $w.Write([int]40)
        $w.Write([int]$size)
        $w.Write([int]($size * 2))
        $w.Write([int16]1)
        $w.Write([int16]32)
        $w.Write([int]0)   # BI_RGB, uncompressed
        $w.Write([int]0)   # biSizeImage, 0 is allowed for BI_RGB
        $w.Write([int]0)   # x pixels per metre
        $w.Write([int]0)   # y pixels per metre
        $w.Write([int]0)   # colours used
        $w.Write([int]0)   # colours important

        # LockBits hands back top-down rows; a DIB is bottom-up.
        for ($y = $size - 1; $y -ge 0; $y--) {
            $w.Write($pixels, $y * $stride, $stride)
        }

        # The AND mask. Every entry stays zero: the alpha channel above is what
        # actually cuts the tile out, and Windows only falls back to this mask
        # where alpha is ignored. It still has to be present and correctly sized,
        # one bit per pixel, each row padded to four bytes.
        $maskRow = [int]([Math]::Ceiling($size / 32.0) * 4)
        $w.Write((New-Object byte[] ($maskRow * $size)), 0, $maskRow * $size)
        $w.Flush()
        return $ms.ToArray()
    } finally {
        $w.Dispose()
        $ms.Dispose()
    }
}

Write-Host ""
Write-Host "Rotman Front Desk - icon" -ForegroundColor Magenta
Write-Host ""

$images = @()
foreach ($size in $sizes) {
    $bmp = New-TileBitmap $size
    try {
        $images += , @{ Size = $size; Bytes = (ConvertTo-IconDib $bmp) }
    } finally {
        $bmp.Dispose()
    }
    Write-Host ("  {0,3}x{0,-3} drawn" -f $size)
}

# ICONDIR, then one ICONDIRENTRY per image, then the images themselves.
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
try {
    $bw.Write([int16]0)                  # reserved
    $bw.Write([int16]1)                  # 1 = icon (2 would be a cursor)
    $bw.Write([int16]$images.Count)
    # Where the first image starts: the directory, plus 16 bytes per entry.
    $offset = 6 + (16 * $images.Count)
    foreach ($img in $images) {
        $s = $img.Size
        # 256 is written as 0 in a byte, which is how the format spells it.
        $dim = [byte]0
        if ($s -lt 256) { $dim = [byte]$s }
        $bw.Write($dim)
        $bw.Write($dim)
        $bw.Write([byte]0)               # palette colours, 0 for true colour
        $bw.Write([byte]0)               # reserved
        $bw.Write([int16]1)              # colour planes
        $bw.Write([int16]32)             # bits per pixel
        $bw.Write([int]$img.Bytes.Length)
        $bw.Write([int]$offset)
        $offset += $img.Bytes.Length
    }
    foreach ($img in $images) { $bw.Write($img.Bytes, 0, $img.Bytes.Length) }
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($OutFile, $out.ToArray())
} finally {
    $bw.Dispose()
    $out.Dispose()
}

$file = Get-Item $OutFile
Write-Host ""
Write-Host ("  wrote {0}  ({1} entries, {2} KB)" -f $file.FullName, $images.Count, [Math]::Round($file.Length / 1KB, 1)) -ForegroundColor Green
Write-Host ""
