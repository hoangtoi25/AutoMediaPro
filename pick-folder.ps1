Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.WindowState = 'Minimized'
$form.Show()
$form.Activate()

$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = "Select Folder to save images"
$f.ShowNewFolderButton = $true

if ($f.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $f.SelectedPath
}
$form.Close()
