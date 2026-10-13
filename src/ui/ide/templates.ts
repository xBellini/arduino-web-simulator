/**
 * What: Curated starter `.ino` sources for new-project / template picker UI.
 * Role: static metadata + source strings — no compile until user runs.
 * Owns/exports: `SketchTemplate`, `SKETCH_TEMPLATES`.
 * Conventions: `filename` is basename without extension; `source` is full sketch text;
 * blink reuses `DEFAULT_SKETCH` from `compileSketch`; examples assume typical Uno pins.
 * To add a template: append `{ id, label, description, filename, source }` to the array;
 * To change default blink firmware: edit `DEFAULT_SKETCH` in `compileSketch`, not duplicate here.
 * Not-here: download helpers (`sketchFile.ts`) or project JSON sketch fields beyond copy-in.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
# 05-10-2026 | Cursor | LCD fake-clock template (LiquidCrystal 4-bit, millis time)
#                     | I2C 20×4 LiquidCrystal_I2C template (PCF8574 backpack @ 0x27)
# 09-10-2026 | Cursor | Moved from `src/sketch/templates.ts` (tree reorganization)
#                     | DS3231 Wire.h template (RTC 0x68 / EEPROM 0x57)
# 12-10-2026 | Cursor | DS3231 template notes editable RTC address in part properties
 */

import { DEFAULT_SKETCH } from '../../avr/firmware';

export interface SketchTemplate {
  id: string;
  label: string;
  description: string;
  filename: string;
  source: string;
}

export const SKETCH_TEMPLATES: SketchTemplate[] = [
  {
    id: 'blink',
    label: 'Blink (LED)',
    description: 'Toggle built-in LED on D13',
    filename: 'blink',
    source: DEFAULT_SKETCH,
  },
  {
    id: 'button',
    label: 'Button input',
    description: 'Read a push button on D2',
    filename: 'button_read',
    source: `// Read a push button on D2 (INPUT_PULLUP)
const int buttonPin = 2;
const int ledPin = LED_BUILTIN;

void setup() {
  pinMode(buttonPin, INPUT_PULLUP);
  pinMode(ledPin, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  bool pressed = digitalRead(buttonPin) == LOW;
  digitalWrite(ledPin, pressed ? HIGH : LOW);
  Serial.println(pressed ? "Pressed" : "Released");
  delay(50);
}`,
  },
  {
    id: 'analog',
    label: 'Analog read',
    description: 'Read potentiometer on A0',
    filename: 'analog_read',
    source: `// Read a potentiometer on A0
const int sensorPin = A0;
const int ledPin = LED_BUILTIN;

void setup() {
  pinMode(ledPin, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  int value = analogRead(sensorPin);
  Serial.println(value);
  analogWrite(ledPin, value / 4); // map ~0–1023 to PWM ~0–255
  delay(100);
}`,
  },
  {
    id: 'serial',
    label: 'Serial hello',
    description: 'Print a message every second',
    filename: 'serial_hello',
    source: `// Print to Serial Monitor (9600 baud)
void setup() {
  Serial.begin(9600);
  Serial.println("Hello from Arduino simulator!");
}

void loop() {
  Serial.println(millis());
  delay(1000);
}`,
  },
  {
    id: 'pwm',
    label: 'PWM fade',
    description: 'Fade LED on D9 with analogWrite',
    filename: 'pwm_fade',
    source: `// PWM fade on pin 9
const int pwmPin = 9;

void setup() {
  pinMode(pwmPin, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  for (int brightness = 0; brightness <= 255; brightness++) {
    analogWrite(pwmPin, brightness);
    delay(5);
  }
  for (int brightness = 255; brightness >= 0; brightness--) {
    analogWrite(pwmPin, brightness);
    delay(5);
  }
}`,
  },
  {
    id: 'lcd_fake_clock',
    label: 'LCD fake clock',
    description: '20×4 LiquidCrystal 4-bit — millis clock (no RTC)',
    filename: 'lcd_fake_clock',
    source: `/*
 * Fake-time LiquidCrystal 4-bit bench (no RTC / no Wire).
 *
 * Wire parallel LCD: RS->D12, EN->D11, D4->D5, D5->D4, D6->D3, D7->D2, RW->GND.
 * VSS->GND, VDD->5V. Use lcd.begin(16, 2) for the 16×2 module.
 * See docs/lcd-parallel-bench.md
 */

#include <LiquidCrystal.h>

// rs, en, d4, d5, d6, d7
LiquidCrystal lcd(12, 11, 5, 4, 3, 2);

void setup() {
  lcd.begin(20, 4);
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
  lcd.setCursor(0, 2);
  lcd.print("ms=");
  lcd.print(ms);

  delay(200);
}
`,
  },
  {
    id: 'lcd_i2c_20x4',
    label: 'LCD I2C 20×4',
    description: 'LiquidCrystal_I2C via PCF8574 backpack @ 0x27',
    filename: 'lcd_i2c_20x4',
    source: `/*
 * I2C 20×4 LCD via PCF8574 backpack (LiquidCrystal_I2C).
 *
 * Wire:
 *   Uno SDA (A4) / SCL (A5) / 5V / GND  →  backpack sda / scl / vcc / gnd
 *   Backpack LCD header (lcd1–lcd16)      →  20×4 parallel LCD pins 1–16
 *
 * Backpack I2C address is 0x27 in this simulator (A0–A2 high).
 * Library: LiquidCrystal_I2C (Frank de Brabander) — install in Arduino IDE if compiling remotely.
 */

#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 20, 4);

void setup() {
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("I2C 20x4 ready");
  lcd.setCursor(0, 1);
  lcd.print("PCF8574 @ 0x27");
}

void loop() {
  unsigned long ms = millis();
  unsigned long sec = (ms / 1000UL) % 86400UL;
  int h = (int)(sec / 3600UL);
  int m = (int)((sec % 3600UL) / 60UL);
  int s = (int)(sec % 60UL);

  char buf[21];
  snprintf(buf, sizeof(buf), "Time  %02d:%02d:%02d", h, m, s);

  lcd.setCursor(0, 2);
  lcd.print(buf);
  lcd.setCursor(0, 3);
  lcd.print("ms=");
  lcd.print(ms);
  lcd.print("        ");

  delay(200);
}
`,
  },
  {
    id: 'ds3231_rtc',
    label: 'DS3231 RTC (I2C)',
    description: 'Read DS3231 time over Wire (default 0x68); match part properties',
    filename: 'ds3231_rtc',
    source: `/*
 * DS3231 RTC module over I2C (Wire).
 *
 * Wire:
 *   Uno SDA (A4) / SCL (A5) / 5V / GND  →  module SDA / SCL / VCC / GND
 *   Left or right header — they are the same PCB nets.
 *
 * RTC address defaults to 0x68 — change via part properties (double-click /
 * right-click → Change properties) and keep DS3231_ADDR in sync (or pass the
 * same address to an RTC library). AT24C32 EEPROM stays at 0x57.
 * Uses Wire.h only (no extra RTC library).
 */

#include <Wire.h>

const uint8_t DS3231_ADDR = 0x68;

byte bcdToDec(byte val) {
  return (val / 16 * 10) + (val & 0x0F);
}

void setup() {
  Serial.begin(9600);
  Wire.begin();
}

void loop() {
  Wire.beginTransmission(DS3231_ADDR);
  Wire.write(0);
  Wire.endTransmission();
  Wire.requestFrom(DS3231_ADDR, 7);

  byte ss = bcdToDec(Wire.read() & 0x7F);
  byte mm = bcdToDec(Wire.read());
  byte hh = bcdToDec(Wire.read() & 0x3F);
  Wire.read();
  byte dd = bcdToDec(Wire.read());
  byte mo = bcdToDec(Wire.read() & 0x1F);
  byte yy = bcdToDec(Wire.read());

  Serial.print("20");
  if (yy < 10) Serial.print('0');
  Serial.print(yy);
  Serial.print('-');
  if (mo < 10) Serial.print('0');
  Serial.print(mo);
  Serial.print('-');
  if (dd < 10) Serial.print('0');
  Serial.print(dd);
  Serial.print(' ');
  if (hh < 10) Serial.print('0');
  Serial.print(hh);
  Serial.print(':');
  if (mm < 10) Serial.print('0');
  Serial.print(mm);
  Serial.print(':');
  if (ss < 10) Serial.print('0');
  Serial.println(ss);

  delay(1000);
}
`,
  },
];

export function getSketchTemplate(id: string): SketchTemplate | undefined {
  return SKETCH_TEMPLATES.find((t) => t.id === id);
}
