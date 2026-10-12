/*
 * Fake-time LiquidCrystal 4-bit bench for the Arduino simulator (no RTC / no Wire).
 *
 * Wiring (Nano example — adjust constructor pins to match your canvas):
 *   LCD RS  -> D12
 *   LCD EN  -> D11
 *   LCD D4  -> D5
 *   LCD D5  -> D4
 *   LCD D6  -> D3
 *   LCD D7  -> D2
 *   LCD RW  -> GND
 *   LCD VSS -> GND, VDD -> 5V, VO -> pot (or hard-wire contrast)
 *   LED+ / LED- as needed
 *
 * Place a 20×4 (or 16×2) parallel LCD from the Output palette, wire as above, Import/compile
 * this sketch, Run. Clock advances from millis() — replace with Relogio features later.
 *
 * See also: docs/lcd-parallel-bench.md
 */

#include <LiquidCrystal.h>

// rs, en, d4, d5, d6, d7
LiquidCrystal lcd(12, 11, 5, 4, 3, 2);

void setup() {
  lcd.begin(20, 4); // use lcd.begin(16, 2) for the 16×2 module
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Fake clock ready");
}

void loop() {
  unsigned long ms = millis();
  unsigned long sec = (ms / 1000UL) % 86400UL;
  int h = (int)(sec / 3600UL);
  int m = (int)((sec % 3600UL) / 60UL);
  int s = (int)(sec % 60UL);

  char buf[9];
  snprintf(buf, sizeof(buf), "%02d:%02d:%02d", h, m, s);

  lcd.setCursor(0, 1);
  lcd.print(buf);
  // Row 2 only exists on 20×4 — skip on 16×2 (begin cols/rows above).
  lcd.setCursor(0, 2);
  lcd.print("ms=");
  lcd.print(ms);

  delay(200);
}
