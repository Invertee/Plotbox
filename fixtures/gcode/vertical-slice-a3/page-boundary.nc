; Plotbox export - files only; no machine connection
; Project: A3 vertical slice acceptance
; Page boundary — pen remains up
G21
G90
G17
G94

; pen up
G1 Z5.000 F900
G4 P0.080
G0 X0.000 Y0.000 F6000
G0 X420.000 Y0.000 F6000
G0 X420.000 Y297.000 F6000
G0 X0.000 Y297.000 F6000
G0 X0.000 Y0.000 F6000

; final pen up
G1 Z5.000 F900
G4 P0.080
M2
