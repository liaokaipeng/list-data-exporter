# gen-icon.ps1 — 生成 List Data Exporter 扩展图标（icon16/32/48/128.png）
# 风格：纯色极简 —— 品牌紫圆角底 + 白色列表符号（圆点 + 行线），与 web-table-exporter 图标同族
# 原理：GDI+ 在 512px 母版上矢量绘制，再高质量降采样到各尺寸（避免手改二进制）
# 用法：powershell -File test/gen-icon.ps1（输出到 extension/icons/）
Add-Type -AssemblyName System.Drawing

$size = 512
$round = 116
$bg = [System.Drawing.Color]::FromArgb(255, 124, 58, 237)   # 品牌紫 #7C3AED
$fg = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)  # 纯白图形

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc($x, $y, 2*$r, 2*$r, 180, 90)
    $p.AddArc($x+$w-2*$r, $y, 2*$r, 2*$r, 270, 90)
    $p.AddArc($x+$w-2*$r, $y+$h-2*$r, 2*$r, 2*$r, 0, 90)
    $p.AddArc($x, $y+$h-2*$r, 2*$r, 2*$r, 90, 90)
    $p.CloseFigure()
    return $p
}

$outDir = Join-Path $PSScriptRoot "..\extension\icons"
if (!(Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# 1) 纯色圆角底
$bgPath = New-RoundRect 6 6 500 500 $round
$brushBg = New-Object System.Drawing.SolidBrush($bg)
$g.FillPath($brushBg, $bgPath)
$brushBg.Dispose()

# 2) 白色列表符号：3 行「圆点 + 行线」（整体垂直居中）
$brushDot = New-Object System.Drawing.SolidBrush($fg)
$penLine = New-Object System.Drawing.Pen($fg, 26)
$penLine.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$penLine.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
foreach ($y in @(176, 256, 336)) {
    $g.FillEllipse($brushDot, 121, ($y - 27), 54, 54)   # 圆点（cx=148, r=27）
    $g.DrawLine($penLine, 208, $y, 384, $y)              # 行线（圆头端点）
}
$brushDot.Dispose()
$penLine.Dispose()
$g.Dispose()

# 3) 降采样导出
foreach ($s in @(128, 48, 32, 16)) {
    $small = New-Object System.Drawing.Bitmap($s, $s)
    $sg = [System.Drawing.Graphics]::FromImage($small)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $sg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $attr = New-Object System.Drawing.Imaging.ImageAttributes
    $attr.SetWrapMode(3)  # WrapMode.TileFlipXY（枚举经数值传入，避免 PS5 类型解析问题）
    $dst = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
    $sg.DrawImage($bmp, $dst, 0, 0, 512, 512, [System.Drawing.GraphicsUnit]::Pixel, $attr)
    $sg.Dispose(); $attr.Dispose()
    $path = Join-Path $outDir ("icon{0}.png" -f $s)
    $small.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $small.Dispose()
    Write-Output ("generated {0}: {1} bytes" -f (Split-Path $path -Leaf), (Get-Item $path).Length)
}
$bmp.Dispose()
