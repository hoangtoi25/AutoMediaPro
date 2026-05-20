Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.WindowState = 'Minimized'
$form.Show()
$form.Activate()

$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Title = "Select Browser Executable"
$f.Filter = "Executable files (*.exe)|*.exe|All files (*.*)|*.*"

if ($f.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $f.FileName
}
$form.Close()
