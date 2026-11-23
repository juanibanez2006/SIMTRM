[CmdletBinding(DefaultParameterSetName = 'Files')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Manifest')] [string] $ManifestPath,
    [Parameter(Mandatory = $true, ParameterSetName = 'Files')] [string[]] $WorkbookPath
)

$ErrorActionPreference = 'Stop'
if ($PSCmdlet.ParameterSetName -eq 'Manifest') {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $sourceDirectory = Split-Path -Parent (Resolve-Path -LiteralPath $ManifestPath).Path
    foreach ($entry in $manifest) {
        $entry | Add-Member -NotePropertyName path -NotePropertyValue (Join-Path $sourceDirectory $entry.file)
    }
} else {
    $manifest = @($WorkbookPath | ForEach-Object {
        $file = Get-Item -LiteralPath $_
        [PSCustomObject]@{ file = $file.Name; path = $file.FullName; sheets = $null; charts = $null; estimate = $null }
    })
}
$outputDirectory = Join-Path ([IO.Path]::GetTempPath()) ('simtrm-excel-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $outputDirectory)
$excel = $null
$book = $null

function Assert-Workbook($workbook, $expected) {
    if ($workbook.RepairMode) { throw "Excel opened $($expected.file) in repair mode" }
    if ($workbook.Worksheets.Count -ne $expected.sheets.Count) { throw 'Worksheet count changed' }
    if ($workbook.Connections.Count -ne 0 -or $null -ne $workbook.LinkSources(1)) {
        throw 'Unexpected external connection'
    }
    $chartCount = 0
    foreach ($sheet in $workbook.Worksheets) {
        if ($sheet.Name -notin $expected.sheets) { throw "Unexpected sheet: $($sheet.Name)" }
        foreach ($cellType in -4123, 2) {
            $errorCells = $null
            try { $errorCells = $sheet.UsedRange.SpecialCells($cellType, 16) }
            catch {
                if ($_.Exception.Message -notmatch 'No se encontraron celdas|No cells were found') { throw }
            }
            if ($null -ne $errorCells) { throw "Cell errors in $($sheet.Name): $($errorCells.Address())" }
        }
        $chartCount += $sheet.ChartObjects().Count
        foreach ($object in $sheet.ChartObjects()) {
            $chart = $object.Chart
            if (-not $chart.HasTitle -or [string]::IsNullOrEmpty($chart.ChartTitle.Text)) {
                throw 'Chart has no title'
            }
            if ($chart.SeriesCollection().Count -ne 4) { throw 'Unexpected chart series count' }
            foreach ($series in $chart.SeriesCollection()) {
                if ($series.Formula -match '\[[^\]]+\]') { throw 'Chart has an external reference' }
            }
            foreach ($axisIndex in 1, 2) {
                $axis = $chart.Axes($axisIndex)
                if ($axis.TickLabelPosition -ne -4134) { throw 'Axis labels are not below the plot' }
                if ([string]::IsNullOrEmpty($axis.TickLabels.NumberFormat)) { throw 'Missing axis format' }
                if ($axis.MaximumScale -le $axis.MinimumScale) { throw 'Invalid axis range' }
            }
        }
    }
    if ($chartCount -ne $expected.charts) { throw 'Chart count changed' }
    if ($null -ne $expected.estimate) {
        $actual = [double]$workbook.Worksheets.Item('Resumen').Range('B6').Value2
        if ([Math]::Abs($actual - $expected.estimate) -gt [Math]::Max(1e-10, [Math]::Abs($actual) * 1e-13)) {
            throw 'Exported estimate differs from the simulation'
        }
    }
}

try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.AskToUpdateLinks = $false
    $excel.AutomationSecurity = 3
    foreach ($entry in $manifest) {
        $path = $entry.path
        # The default is xlNormalLoad: no repair/recovery mode is requested.
        $book = $excel.Workbooks.Open($path, 0, $true)
        if ($null -eq $entry.sheets) {
            $entry.sheets = @($book.Worksheets | ForEach-Object { $_.Name })
            $entry.charts = 0
            foreach ($sheet in $book.Worksheets) { $entry.charts += $sheet.ChartObjects().Count }
        }
        $excel.CalculateFullRebuild()
        Assert-Workbook $book $entry
        foreach ($sheet in $book.Worksheets) {
            foreach ($object in $sheet.ChartObjects()) {
                # A hidden Excel instance still needs activation to complete text layout.
                $sheet.Activate()
                $object.Activate()
                $object.Chart.Refresh()
                Start-Sleep -Milliseconds 200
                $imagePath = Join-Path $outputDirectory ($entry.file + '.png')
                if (-not $object.Chart.Export($imagePath, 'PNG')) { throw 'Chart rendering failed' }
                if ((Get-Item -LiteralPath $imagePath).Length -lt 2048) { throw 'Chart image is empty' }
            }
        }
        $roundtrip = Join-Path $outputDirectory $entry.file
        $book.SaveCopyAs($roundtrip)
        $book.Close($false)
        $book = $excel.Workbooks.Open($roundtrip, 0, $true)
        Assert-Workbook $book $entry
        $book.Close($false)
        $book = $null
        Write-Output ('PASS Excel open/calculate/save/reopen: ' + $entry.file)
    }
    Write-Output ('Excel ' + $excel.Version + '; verified workbooks: ' + $manifest.Count)
    Write-Output ('Temporary roundtrips and rendered charts: ' + $outputDirectory)
} finally {
    if ($null -ne $book) { $book.Close($false) }
    if ($null -ne $excel) {
        $excel.Quit()
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
