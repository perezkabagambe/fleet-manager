'use strict';
// Local end-to-end test server: serves web/ and answers POST /api with the REAL backend code
// (running against in-memory stand-ins for Sheets, Drive and Mail). Nothing here touches Google.
//   node tests/devserver.js        then open http://localhost:8124/
// /__as/admin or /__as/sam switches who you are signed in as.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createEnv } = require('./harness');

const PORT = 8124;
const WEB = path.join(__dirname, '..', 'web');
const env = createEnv();
let kept = null;

env.seedUser({ name: 'Perez Kabagambe', email: 'perez@example.com', role: 'admin' });
env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
const tokens = { admin: env.signInAs('perez@example.com'), sam: env.signInAs('sam@example.com') };
let persona = 'admin';

// A pretend Gemini, so the receipt Inbox can be tried locally. A file whose name contains "invoice" reads as a garage invoice.
env.props.GEMINI_API_KEY = 'local-test';
const FILL = {
  details: { make: 'Kia', model: 'Sorento', year: '2013', colour: 'Black', engineCode: 'D4HB', gearboxCode: '', market: 'European', driveSide: 'RHD', fuelCapacity: '71' },
  fluids: [{ fluid: 'Engine oil', specification: '5W-30 ACEA C3', capacity: '6.7 L', notes: '' }, { fluid: 'Brake fluid', specification: 'DOT 4', capacity: '', notes: '' }, { fluid: 'Coolant', specification: 'Long-life 50/50', capacity: '', notes: '' }],
  bulbs: [{ location: 'Dipped beam', type: 'Xenon D3S 35 W', quantity: '2', notes: 'Halogen versions use H7' }, { location: 'Full beam', type: 'Halogen H1 55 W', quantity: '2', notes: '' }],
  summary: 'A 2013 Kia Sorento 2.2 CRDi (local test answer).', confidence: 'medium',
};
const MATCHES = { candidates: [
  { label: '2013 Kia Sorento 2.2 CRDi (D4HB), European', why: 'The common diesel', confidence: 'medium', details: FILL.details },
  { label: '2013 Kia Sorento 2.4 petrol (G4KE), European', why: 'The petrol version', confidence: 'low', details: { make: 'Kia', model: 'Sorento', year: '2013', engineCode: 'G4KE', market: 'European', driveSide: 'RHD' } },
] };
const LOGBOOK = { isLogbook: true, registration: 'LB06 XYZ', vin: 'WBAVB11060PK12345', make: 'BMW', model: '325i SE', colour: 'SILVER', dateFirstRegistered: '2006-03-01', engineCapacityCc: '2497', fuelType: 'Petrol hybrid', fuelTypeAsPrinted: 'HYBRID ELECTRIC', transmission: 'CVT', acquisitionDate: '2025-05-25', bodyType: 'SALOON', confidence: 'high' };
// Other websites (the parts catalogue icon): the catalogue site refuses servers, so the icon comes from Google's copy, as it does for real.
const LLL_ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAmVBMVEVHcEyTpsoTSps6cq0iNVpDg8AlNHoWLm+vw90iLmpEcqAiMHJEg8ATRYobK2QXLV5NeZ4VSZgRRY1Lg7wgKmZGfrcXS5dSZXkURZBDf7lMgrdDerTc6PgZUaQpOYZKishIi8v+//8oOYMYUqhFhsUfMHs8gcMpOYkUTqABQJYUS50PInS70OTU4u5deKzz/P2Lk6k+SHhtmL83gev6AAAAHXRSTlMA/sJFHsL9Sv25LdjlZ2kzHeqJgo9v1QuvlVeoUfXgWBQAAAOQSURBVFiF7Zdrd6IwEIbVIqBUrVov1QZyARIQsbv//8dtgiAzY+3u2f2wX/pSezgc83aeTJiZDgbf6vW++7f1YTgMsN6rNXmye6ICBvvTKfMzoMmxKI0xpSntj3G/9+uUaAwMMh1baXfp5mZRMqbYTYqpxTNPkFIQwcKPobT0F4ZhldM0IQYggFeJDGL5uiLr1X5NAkgggU/Wy2BJDFhACZLDQ4JYZtM/INg9JtCTFdzBhmBDAuCIgBjEnxGQAPgGEkiN1meewQGw8iVNcAiIQIMI3O1kxhR2GB1IACgHEf77sQy2ZL2ZjUkACSDwpIxBCNoRkD10BCQHL73BHC53h3kyU9hAbQ/0EDxDAmggtdTzEWPYwRLgFCRrQODjLdC+VyIDxYyX8qTfBJ5wRCCtoEEUKPImbp/oIXhI4CDme7wFis2OCUkCINj5tpZAD0tgigI6OII8T3sLnk4BwSms6gxsQxSY+lz1Dootp0lenUOQSUgwOZ3FR4YITC1EARBWbzw/iyrvDd6AQUYMHEEtLgUiSLABJAgkMYgWhhhYAmKACDQ2kPMVIwaWABtwRBBjA99bEoPSeyYRIIKYIFgChQ2WLymJABLYatgYtGnUzTlGBmrp3kRkkAODgX/dA0kQQBqNReAPEWw1ghHYE/m6uiKoRu5MrzZNBGG/iUfIIE+VqE6dMh15xigh6qJTw5BX4px3SmFPGmTZUIgqbFX7jqG4iEv3JCwcQ2q/dK5aDRHDRMrLRXSy+bBdrRyK2yO7nSvb1fL+O6JK4UEIZFYLYCBtIllRid5ALW1XSn/2DiFh0NmPj2GrWjaJVEXdPRmWyr3OPE1uUMMUM2gts9sm2tZuC4piZVGU18vl4c1uPe83Eb+OgXR9qa1r7j56cn2pTaMbLdgSd1bO0WHc+Vq7wcSNJs3HMtz6imqu8lpUe+GzFLl13VG0Vd0yoJrsyvqR45rIQVF0Zbk9iI5CurLMaGP5sizv/Fijwuzftzbvq9bmCjsykPMRaa53rQkV9sFckwHDtXdssD3Q7gwZPMuADO4HDPNlex5EOAIdB1tGdMcARxw7ZGlscM8w2lCDMWIgM4obMZDU3ZjHSR6wXB6wgflNHoiBZcAhKDukUAOSB7yNWTNk/DWDfR9oHtQnYw7KAzZwgxZNJMkDx6NiN263Z1rqT4bVqRtW+7fSVhj4f9aEarEfES2OYyIw8H/rP+oX+yFEtZqxF4cAAAAASUVORK5CYII=', 'base64');
const PSQ_ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAT/klEQVRogbWZeXhc1ZXtf/vcW5NUpdmSZcuyZFm28YRHbGMbmzHMiUkwkBAzpiGQ7k4nNA4JAZomIf1IeEkec2hwGEIDgRBDG2NjwGa0jecRy5IlWdZgqVSSSjXXPaf/qJKwjUKbfu+d77vflapu7bPW3mvvs8+5wv+D4b3hUXQclIscQU5xtDk9mXbmgNQKlIMptkSSlpIuoFmM2YnwjmizcXgqcrTH9hD60w//R3PL/xXy0TdC03/ApfeUk+s9V9nWZUrJrGK/p/TsiRWuHLeFbSlyPS4Otvfy1s5mHG3Q2hglhJWwB8xLdjrxanXdq4eDpdNM26qH/v8T8F33OEpZpNJOcUnA+60JIwpunDiicGp7X8z95q4WplYU8cBVcxkzLI9cj01dRy8vb6znN2/uoLwgh4kjCmkJhjnY3osxOMroPXak80nvgXUvdT21oWP8HOGzk8RifVXwuTc8jiXYCc2ZPo/rtz/7+ozv337R9FEzqkusK+aMpTEYYX1dB69va6aiMId42uGyh9fxfl0HwwtyeOK6Rdx67mSWzBpDyjFsPxxUBinTLt+5xpOzoOCRf0glY8GmXE2ioGo84Z7gl+JRXwW858Z/x4iVnxDrdiz1fEJzTllBrqslFOHKR9+lJRRhyqgioo6mM56iMOCltSdKdzRNNA1nTapg4shCbl3xAS9vPkRejgcjCqMELMtOldScHh+76HFTVP4C+f4L030d7rKi/C/FZJ8U8in/TOGS+aRbOiujIveJUlci4koaqO8KM2VkIWeeUo7f6+LT5m6Mssjxuhien8NH9UdxBLAUKQM+t01ahLv/ug3bFhwlgEJrjaBIVMzwSbzvAu/+t+Zh9NMgD5QV5rehFB3B0FePQM1VdzNz6QK8PX21P71s1uPLTq+92mXbLi0KI0JzMMLYsnzuuHgafo+Lo+E4iCLP66Yw10MwmkSLQpRi7b52NjZ0cu+SmVSX5RHX4KBwu21qSvMoL8jBiJAYM5/0iKkFGP2PYP6gMWMxekh8X0rAf+MTNAeq2Xbo6DitrMcXTRhx/iPfnS/3LZlOWcALCEcjScKJFPe9sZPGYIR//fp0RhX5yfV68NgWR3rjeN0uLp1aAcCv1+5lWMDL1FHFGAOnlBfw+LIFvHnbhfzlh+dz4amVOJaH+LizMDlFCmMuUiKPGKguK86nIBA4DuOXJrE951vYYkZqsR5Kac47b9IIcj0uZlQWM6e6hF1tvURSmqUzRvPitsOs2tvK7KpiPmkKEoylMAbe2teGsiweWjqLy2dWMWt0CQGvi0c31FGU4+bp6xZQWezn9+v2YYAlM6v4zx3NhMWHlY5jd9WDSI1AiSj1tstWif5o/L8nINc+QTqRCqSU9UuUXOEYIzMrS9DacKCjlyUzqjhzXBmtPTGMwMfN3exoD3PwaJjhARc1RT56Y0nyc30kHMOnzd0M83vweWx+9+4BNjYG+dU3plNZnMu1Kz7kr9uaSSRSLD2thlW7Wmjvi4OvAFfHXiQZA5EJGII5+eUbvTb0R6MZJw8F3nXu/aRWvKmqfnz5TUX5Ocvawwlp7YtzsKufmxaN43Aoyk9XbmdmZTFpJfx2/UGmFQlnj00RSDeSa4Fx0jQ3NhFLpjlz7ETixdW8trOFjxq76Y0lmTQ8jwVjy7h/9S62HA7h8ticM6WC/kSKzkgSUYLjLyFdNgF3w4eAuMH8INrb9jawe1AlQxFYfvPZfPaNWQuuPr32n+bVlHp2Hunhe899QkMwQjyluX/NXp7fepgxJQHOqfSxOLadwiMx5s6dS9WYGRQXl+D1+XhmxVPc/uMf4fN6+ebll7N0/mJmzRnNY9s6sW0LA7T2xvG5XVw/t4rr5tfywOpdtIUTGFGgIFU2EXfTJtAOQA1wTX5ByXLLdukjHZ1flNDXHniDDfvbipdfPO03JQHfjOc2NnDB5AoaQzG2t/Zw2bRRrN7XjhbFkpI+Gl59iI3vvMntd9zJvPkLcLldhHpChLpDBPwBxo2fwCkTJ/H9H/w9Aa+H/rqtTK8dzeajSSaWBVgyrYILJ4/k6jljeGHzIR5Yu5eE41BZmINjDElj4W7djSQjIAJQlkjGVxmju/uj8eMjUPmjp1l920X8ZvXOK+bVlJ37zMf1PPtxA5eeWoljoK0/wYqNjXhdFpe4G1n/+MP0hfu59oYbiUT6ue/ee9j4yce0t7WRTCTx+/2MqanhnPO+hj+Qx+iqagJ5+ax7ey1XjJvOfWv3c9O8asoCHn70ylbe2NnCmGEBls6o5GuTRvDDFzbxQSSGk1eK6u8YSNlqo/W5xui6qspRxxM4GjPI9U9UTasqvammLN917eljmTG6mJQ2rK8/SjRteH1PGxe5mxjlirH4X+4jkUywc/t2br7xBtrb2zDGZIpAxlt89tl+1q1dyxuvr+Sue+5lytSpJJMJNm3ZzujCan7wlx240JwyzM+Dl8/kvAnlpLVm1a4WWnqi4PLg+EtxGQY6NwWcI2I9FesPxwclVHTLU4TDebhzzE2t4fi33/msXfxeF0umV9LWG+P1vW2gLJYU9TAxJ8Gya6/Htm1+9+CDvPLyS4TDYZRSFBQWUjmqktKyMpQSkskkWmsaDtazfdtW5sydR+248ax85UWqy4exJeymosDLM1fPYXSRnxUfN3Dnyu08v6mBYCSJUgo73IGrff+AhABcwGtAzyABM3MJLndypIP8QlmqPJo2vF/fRWd/gm+cOooivxcV7mK6tHPlVd+mra2Nf7j1Fj768AMAqsfU8L2/u5nblv+EZddez4KFZzB23DjcbjdHWo7gOGna2loJhUIMKy3jgV/9ilK/B1f1NOZWlTCzopCrnv6IV3a0cDScIOCxmTQ8n1AsBX2duFt3HlcoQdYaaLAB8m55mr604BJzFsIkQRAlJAw89lEDB4IRakv8jI/Vc+YFZ6GN4d67f86nmzdhWRYXXHgRd9z5c6qrx/Duu+/w6EP/h127dhLu68OybbR2EBEsy2LtW6uZN+90SkpK2PLhembP/gb5OR5aQlHqg1HK8nycUzuMq2dXUZjjZukfNtBhebLKcQYI+MFMQOu3bYC0FvzieOKiLkHEjQgDl1HCew3djEh1MsUnjJtwCo8+/BBvr12DiHDRJZfyb79+EEsp7rnrTl54/jnC4T6Usgbz4Nh7f38/W7du4bobv8c7a1aTl+jiYDCX62eP4vErZzG+NMCoghw2N3bx67V7CEaTiGVhRBAzGAExUDm2siqTxI4BBzUWZN7AFscgIKCBcSW5qPq1HM5R1B04wDMrniKZTDJt+nTuuude3G4Xd9z+z/z5pRcREWzbdWJ1/nxmEXZs38Zd//KvzJo1k9Vb9rO5JcQTnzRy3rhSPm7s4kdbDrOtOUgskckBj3EQY463A3l1hxtVJgKZAjUHKBc+9352Rqbkw4HX1pMeU8NfXv0zjYcO4fP5uOn7t1JVXc3/+tUvefXPLyMig97+W0MpRTAYJNjVRWnZcPI9dSDwi3cO8IePGhgRcOO1FcW5HtpSaRBBnCRDdKMeJUps/81/xKvF6hV9OnLMwiYZ8DluF8WRVjY3NfLNby1l3bq1pFIpZs0+jfPOv4BtW7fwzNNPobVGqZPbHyUTCfr7w5SWDkOn0ygRSgMefnHeKVwyqRyfy6Ip2M/PV27njd1tqHg4Q+B45xgAldSaME6+gYmDwBEE0MYwLNeDJ9zGFd/5LmNra6k7cAClFAvPWER+fj5/fulF2tvbTxr8gHdEFOlUCgdBEJYvruWs2mE8+sFBlq/cQUc4zvKvTaYk141EQ0NFIJ5KJLQtgGBGYKTKDELPTGIMFHsVVb4CrvnHm1i7Zg09oRAer5fJU6bS3d3NB+9v+G9lc9wwBo/XQ15eHj2hEL0pTa7bZnFNCXeu2sMLW5sh7bDrcIgnv3MaZbk2TeHOocz0lJSWGGUAg5QDgRNhGCDPZSjKC+AP5NHR0UE6ncbr9VJWVsahhgaOtLR8Je9rYyguLsGyLbZ8upm48jC7spB8r4t9HX2QTdaKQh+xlJMpxf2dJ8pHKyVNXV3d2GnAMmY0Ch9IxsBA/gJ+y2CJwbIsopEIxphMeiih82gHsVjsK0XAGMPESZNY8dS/8/769/jfTz7LiIpKct2Kf1pcy193HqE84OGWBWNZ99lROo80kRMNnUig3xhzwOVyYWvtxpb4CGPEyuYFBoOQEZQlMtjfeL1elAjxeJyuzi6MMYPfnezweDyMGz+eV19+iaracfS7Aty9Zi9eS/jxoloumzISRxvW7GvjwXX7oLMBScVAjotyl4g0Adi3vH0nT579swIswGRqv2RYYDDEtBBLJEilUgwrLcWybZKJBDu2b2XBwkV4PB6i0ehJRcFxHCZOmkxFxSh6Qt1UzV7Mda/tpb6zD9sY1n3WwZgiH72RJDtaQvSH+8nv+Ow4VQAIss/lcrUbY1CPTL7GMkbnDWjPYLI6zEilNy20dnSyfdtWKisryc/PxwBvrV6Nx+th1KhKtB76xODEYds2V171bc459zwuu/wKOgtraeiOgICDYU9HmJW7W9lQ30l/0sEVbsPqbjrR+wAf9/X1RN0eL4rX73ZECGW8bgZUBFmtByNpelPCDcu+S0NDA1NPnQbA3j27ee3VV5i/8IyTSuJ0Os3CRYu4/Mqr6Al1M2LyLNZ3GozOrLJiQInBVoItghiDu2UnEg+fqP+QgfVebw4NzS0ovvckYqR7ELwxg5cC2vriqLIxRCNh1r/3LhdefDEejweA5559hra2VoYPH/6lueA4acbW1nLHz+4iJ8fH3n37+NQZxoHuSNZZZEkY0BkYKtqN+/C2ocxtE5Fdko2KcmsBTBPGpDB6UPtkDUYTSQ5bw5gyfSa2bXPp15dw4cWX4DgO8ViMt95cRSgU+ps5kE6nqRlby7/9+kGmTZ/Otk83sy+Zy8qmOEZrRBuUNgzMPSABz+HtqN72E+WjRWSlTqd7B6JiCxqBZtARkIIMA8kYMpnjvo9bo3znzEsJRNopKi7mZ3fdTW9vL++ueztbiTTHH3QbHEejLMX8BQu5+ZZbmTvvdLZu3sSu9jB/OuylMxxDyHrdZIigMyqwIt246z/Ktg/HEagTkf9Utk17VzcAlmvaxdnv5DJESo5t5Aaas75YmqLyCvJ6DmED06bPYMHCMxBRtB5pIRzux0mncbTGGIPb7WHcuPFcc931TJ4ylWf/uIID+/fR78nnT8F8Nh7py4DX2cvoQdmK0fj2r8PdtPkLySvIY/5A3quOkyYciWUi4FKCEo7GHbMHbcYb0YPl1BiDaI0oWFvfw6iJ83n3vffw+XycNncuP/zxbSw+6ywO1tXRUF9PKpmkuKSYqadOY/acOezdvYfrr7ma0tJhuEZN4IWeYt5v6hnUu2idAa8z/xvA7mrEU/c+fL4HHhj7lJJn+8N9pj3YM/ih7cOhMy1xt8gGjFki2ogRDdoCld2ga0M8keRPB6J8d8J83lyzls2bPuFQwyE2b97EGYsXs/yOn1JQWJgRkDEEg13s3L6Fs8+/kJFnLeWVNpvd7d0oyMrGfA5eZ4tGMoJv96pM83a891PAY7alDsQSqROiAniveQwRmaphlVEy0igLoxQolenHRUAUWoQcr5uLxhUxPlbP3g2r2L9rB46juW35T6gZO5Z4PE53d5BQf4y+nDK2OiWsaeihJ5rEEo6RyjF3nZGQb89qfDteH0zkY8abSlnLwHS1dYW+SMB/zaNYxrgSop7QSq5FFMYSjFiZfFCZ9heRzAsJUVQW+5lX4afKHcOOBNGJKG6PB+0NEFQB9oUtdhyN0tUfz6TVMZ4nW/cxJlOJBDxNW8nZ+BySjJ5Y9w8rpa7SWn/Y0d17IrHMllKJJoGVUpgVRnMxSpfgKLA0BjVYWjOtt0YwNHf10dQVxu22CXgD2FY+2hhiaYdIsgdHGyyVPYoaWKiPAc5A9UFwddTh2/ZK9vTtOOn0A79MOZ6PXNbx0hkYFkBi+ypypl2AS3SrY2SkgdPIVlKRgUAJA7tqybYmSkBrQzyZIpJIEU2mSKczBFX2OXT2ef15yRy4jAiuYCP+Tc+j+jpOBJ8Wkd+7PZ7fWeKkWjuHfld2XKxylj2CgpoU8iIiM1Ey+A7LKCvzuJJj8iJrQgYIDmXWDHo/G8qMdEThOlqH/9P/QPUc+cKCBTwNcpvjOD1dveEhwcMQb2iSSL3C3IExzWRrtGiNchwwTibhdEa7RmuMydzRA98N/O0Mfmb0Mb/LLnye5i34P/njUODTICss2/6JUtJTVlb1N8F/IQIAgWUPk28jXSn5lkF+i5IRCNnjbsFkE/nEk4vjLQ2xtzMZGyoZxXdwA97964bSfAx4DOQ+Y3T30VDfl4IfkkCGxO/xWFr1p93nG+R+hKkDh1yDB17Za1A+A0SGnEVAa1zBRnz71+Bq2zfUKUMrcL9S6iljTPTYxeorEwAoWvYwj/jDXBfOO0XDbYh8EyF/APyA5gdJyMAeLmPSZHNDjIPV1463cSPu5i1IvG+oReod4JeJRPoDpUR3h/tPCvyXEgAovfQO+vIqUDrt1ZZroUG+jbAYGIGI+zjwWVIiAtpBkhHsnhbcrbtwte9FYj18nvBA5jxtN/AHbcyLtm0He0IhYumvtkU9qd24vfBZXNV94IjbKFNtRE4VY2aj09MknaiUdLxM0gm/JCOWFQ2ieluxeo5gRbognTgWuAa6gR3AK9qYNwR3C6TN0dDJSeZ/RODEkX/J7eTYlkQ6DuXafW3lkghXqWj3dJXsn0E6MQljyhHJzdbaeBZ0HbBRkHe0MdutEYU9uqOXjq4vvn3/KuO/AC6RONwSn4UWAAAAAElFTkSuQmCC', 'base64');
env.state.web = (url) => (/s2\/favicons\?domain=partsouq/.test(url) ? { code: 200, body: PSQ_ICON } : /google\.com\/s2\/favicons/.test(url) ? { code: 200, body: LLL_ICON } : { code: 403, body: '<title>Just a moment...</title>' });
env.state.gemini = (req) => {
  if (req.body.contents[0].parts.some((x) => /V5C/.test(x.text || ''))) return { code: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(LOGBOOK) }] } }] } }; // reading a log book
  const prompt = (req.body.contents[0].parts[0] || {}).text || '';
  if (req.body.tools || /Return this JSON object/.test(prompt)) { // car lookups (with Google Search)
    const answer = /There is no VIN/.test(prompt) ? MATCHES : FILL;
    return { code: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/sorento', title: 'example.com' } }] } }] } };
  }
  const part = req.body.contents[0].parts.filter((x) => x.inline_data)[0];
  const garage = !!part && /invoice/i.test(Buffer.from(part.inline_data.data, 'base64').toString('latin1'));
  return { code: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(garage
    ? { documentType: 'garage_invoice', title: 'Full service and brake check', vendor: 'Kampala Motors', date: '2026-09-15', currency: 'UGX', total: 450000, workDescription: 'Full service and brake check', mileage: 51234, confidence: 'medium' }
    : { documentType: 'parts_receipt', vendor: 'Euro Car Parts', date: '2026-10-02', currency: 'GBP', orderNumber: 'ECP-5521', total: 71.97, items: [{ name: 'Front brake pads', partNumber: 'BP123', quantity: 1, unitPrice: 41.99 }, { name: 'Oil filter', quantity: 2, lineTotal: 19.98 }, { name: 'Delivery', quantity: 1, unitPrice: 0 }], vehicleRegistration: 'AB12CDE', confidence: 'high', summary: 'Brake pads and oil filters (local test answer).' }) }] } }] } };
};

// A little starting data
const mk = (fields) => env.call('saveCar', { token: tokens.admin, fields }).data.car;
const car1 = mk({ registration: 'AB12 CDE', make: 'Toyota', model: 'Land Cruiser', year: '2015', vin: 'JTMHV05J604123456', colour: 'White', odometer: '51200', country: 'UK' });
mk({ registration: 'UBA 123X', make: 'Toyota', model: 'Hilux', year: '2012', odometer: '210450', country: 'UG' });
env.call('setGuestAccess', { token: tokens.admin, carId: car1.id, enabled: true });
const guestSecret = env.call('getCar', { token: tokens.admin, id: car1.id }).data.car.guestSecret;
env.call('saveFluids', { token: tokens.admin, carId: car1.id, fluids: [{ fluid: 'Engine oil', specification: '5W-30 ACEA C3', capacity: '5.5 L' }] });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'POST' && url === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let out;
      try { out = env.ctx.doPost({ postData: { contents: body } }).getContent(); } catch (e) { out = JSON.stringify({ ok: false, error: 'server_error' }); console.error(e); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out);
    });
    return;
  }
  if (url.startsWith('/__as/')) {
    const who = url.slice(6);
    persona = who === 'sam' ? 'sam' : who === 'guest' ? 'guest' : 'admin'; // guest = signed out
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }
  if (url === '/__guestlink') { // the address the first car's QR code holds
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('http://localhost:' + PORT + '/#/car/' + car1.id + '?g=' + guestSecret);
    return;
  }
  if (url === '/__outbox') { // the emails the backend would have sent, for checking them by eye
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(env.outbox));
    return;
  }
  if (url === '/__keep' && req.method === 'POST') { // dev only: keep a file the page made (e.g. an exported PDF) so it can be opened in the browser
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { kept = Buffer.concat(chunks); res.writeHead(200); res.end('ok'); });
    return;
  }
  if (url === '/__kept.pdf') {
    res.writeHead(kept ? 200 : 404, { 'Content-Type': 'application/pdf' });
    res.end(kept || '');
    return;
  }
  if (url === '/__reminders') { // pretend it is Monday morning: run the weekly job now
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sent: env.ctx.sendWeeklyReminders() }));
    return;
  }
  if (url === '/sw.js') { res.writeHead(404); res.end(); return; } // no service worker while testing
  if (url === '/config.js') {
    const src = fs.readFileSync(path.join(WEB, 'config.js'), 'utf8')
      .replace(/apiUrl: '[^']*'/, "apiUrl: '/api'")
      .replace('__COMMIT__', 'e2e').replace('__BUILT_AT__', 'local');
    const login = persona === 'guest' ? "localStorage.removeItem('fleet.session');\n"
      : "localStorage.setItem('fleet.session', JSON.stringify({ token: '" + tokens[persona] + "', expiresAt: '2099-01-01T00:00:00Z' }));\n";
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    res.end(login + src);
    return;
  }
  const file = path.join(WEB, url === '/' ? 'index.html' : url);
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
}).listen(PORT, () => console.log('E2E test server on http://localhost:' + PORT));
