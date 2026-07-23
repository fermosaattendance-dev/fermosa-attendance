@{
  # Clone-kit brand tokens. In a clone: copy this file to brand.tokens.psd1 and
  # fill in the values, then run rebrand.ps1. The real brand.tokens.psd1 never
  # exists in the Fermosa source repo — that is what stops rebrand.ps1 from
  # rewriting Fermosa itself.
  Display  = 'Acme Clinic'          # company display name (replaces 'Fermosa Skin Care Clinic' / 'Fermosa')
  Domain   = 'acme.local'           # login username domain (replaces fermosa.local; must match what admin-users mints)
  Title    = 'Acme Attendance'      # app / browser-tab title
  Short    = 'Acme'
  Scheme   = 'acme'                 # mobile deep-link scheme
  Slug     = 'acme-attendance'      # package / project slug
  Bundle   = 'ph.acme.attendance'   # mobile bundle id
  Label    = 'acme'                 # lowercase label (backup workflow name)
  Initials = 'AC'
  Subtitle = 'Attendance'
}
