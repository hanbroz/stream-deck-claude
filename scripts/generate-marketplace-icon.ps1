param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\com.hanbroz.claude-usage.sdPlugin\imgs\plugin")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$resolvedOutput = (Resolve-Path -LiteralPath $OutputDirectory).Path
$categoryIcon = Join-Path $resolvedOutput "category-icon.svg"
$svg = Get-Content -Raw -LiteralPath $categoryIcon
$pathMatch = [regex]::Match($svg, '<path\s+d="([^"]+)"')
if (-not $pathMatch.Success) {
    throw "Official Claude path was not found in $categoryIcon"
}
$pathData = $pathMatch.Groups[1].Value

function Write-ClaudePluginIcon {
    param(
        [int]$Size,
        [string]$Path
    )

    $canvasScale = $Size / 144.0
    $geometry = [System.Windows.Media.Geometry]::Parse($pathData).Clone()
    $transform = [System.Windows.Media.TransformGroup]::new()
    $transform.Children.Add([System.Windows.Media.ScaleTransform]::new(0.896 * $canvasScale, 0.896 * $canvasScale))
    $transform.Children.Add([System.Windows.Media.TranslateTransform]::new(16 * $canvasScale, 16 * $canvasScale))
    $geometry.Transform = $transform

    $visual = [System.Windows.Media.DrawingVisual]::new()
    $context = $visual.RenderOpen()
    try {
        $background = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromRgb(20, 20, 19))
        $claude = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromRgb(217, 119, 87))
        $bounds = [System.Windows.Rect]::new(0, 0, $Size, $Size)
        $radius = 28 * $canvasScale
        $context.DrawRoundedRectangle($background, $null, $bounds, $radius, $radius)
        $context.DrawGeometry($claude, $null, $geometry)
    } finally {
        $context.Close()
    }

    $bitmap = [System.Windows.Media.Imaging.RenderTargetBitmap]::new(
        $Size,
        $Size,
        96,
        96,
        [System.Windows.Media.PixelFormats]::Pbgra32
    )
    $bitmap.Render($visual)
    $encoder = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()
    $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
    try {
        $encoder.Save($stream)
    } finally {
        $stream.Dispose()
    }
}

Write-ClaudePluginIcon -Size 144 -Path (Join-Path $resolvedOutput "marketplace.png")
Write-ClaudePluginIcon -Size 288 -Path (Join-Path $resolvedOutput "marketplace@2x.png")
