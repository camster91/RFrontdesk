# RFrontDesk 1.1.3

Backup save and read results now report actual UTF-8 file sizes. Names containing accented or non-Latin characters previously made those results understate the number of bytes; the backup contents were preserved.

New real-filesystem regressions verify atomic save/replacement, readback, Unicode/BOM sizes, failure preservation, path confinement and automatic backup retention without removing manual backups. Windows downloads are signed by Cameron Ashley. Use the MSIX for installation or extract the portable ZIP before running it.
