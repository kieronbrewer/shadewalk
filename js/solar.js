/**
 * Solar Position Calculator
 * Implements standard NOAA solar calculations to find the sun's azimuth and elevation.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * Calculates the solar position (azimuth and elevation) for a given date, latitude, and longitude.
 * @param {Date} date - The date and time for the calculation.
 * @param {number} lat - Latitude in degrees.
 * @param {number} lon - Longitude in degrees (positive East, negative West).
 * @returns {{azimuth: number, elevation: number}} - Azimuth (0-360 degrees clockwise from North) and elevation (degrees above horizon).
 */
export function getSolarPosition(date, lat, lon) {
  const latRad = lat * RAD;

  // 1. Get Julian Day (JD)
  const time = date.getTime();
  const julianDate = (time / 86400000) + 2440587.5;
  const julianCentury = (julianDate - 2451545) / 36525;

  // 2. Geometric Mean Longitude of Sun (degrees)
  let geomMeanLongSun = (280.46646 + julianCentury * (36000.76983 + julianCentury * 0.0003032)) % 360;
  if (geomMeanLongSun < 0) geomMeanLongSun += 360;

  // 3. Geometric Mean Anomaly of Sun (degrees)
  const geomMeanAnomalySun = 357.52911 + julianCentury * (35999.05029 - 0.0001537 * julianCentury);

  // 4. Eccentricity of Earth's Orbit
  const eccentricityEarthOrbit = 0.016708634 - julianCentury * (0.000042037 + 0.0000001267 * julianCentury);

  // 5. Sun Equation of Center
  const sunEqOfCenter = Math.sin(geomMeanAnomalySun * RAD) * (1.914602 - julianCentury * (0.004817 + 0.000014 * julianCentury)) +
                        Math.sin(2 * geomMeanAnomalySun * RAD) * (0.019993 - 0.000101 * julianCentury) +
                        Math.sin(3 * geomMeanAnomalySun * RAD) * 0.000289;

  // 6. Sun True Longitude and Anomaly (degrees)
  const sunTrueLong = geomMeanLongSun + sunEqOfCenter;

  // 7. Sun Apparent Longitude (degrees)
  const sunApparentLong = sunTrueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * julianCentury) * RAD);

  // 8. Mean Obliquity of Ecliptic (degrees)
  const meanObliqEcliptic = 23 + (26 + (21.448 - julianCentury * (46.815 + julianCentury * (0.00059 - julianCentury * 0.001813))) / 60) / 60;

  // 9. Obliquity Correction (degrees)
  const obliqCorr = meanObliqEcliptic + 0.00256 * Math.cos((125.04 - 1934.136 * julianCentury) * RAD);

  // 10. Sun Right Ascension (RA) and Declination (degrees)
  const sunDeclination = Math.asin(Math.sin(obliqCorr * RAD) * Math.sin(sunApparentLong * RAD)) * DEG;
  
  let sunRtAscension = Math.atan2(Math.cos(obliqCorr * RAD) * Math.sin(sunApparentLong * RAD), Math.cos(sunApparentLong * RAD)) * DEG;
  if (sunRtAscension < 0) sunRtAscension += 360;

  // 11. Equation of Time (minutes)
  const y = Math.tan((obliqCorr / 2) * RAD) * Math.tan((obliqCorr / 2) * RAD);
  const eqTime = 4 * (y * Math.sin(2 * geomMeanLongSun * RAD) - 
                      2 * eccentricityEarthOrbit * Math.sin(geomMeanAnomalySun * RAD) + 
                      4 * eccentricityEarthOrbit * y * Math.sin(geomMeanAnomalySun * RAD) * Math.cos(2 * geomMeanLongSun * RAD) - 
                      0.5 * y * y * Math.sin(4 * geomMeanLongSun * RAD) - 
                      1.25 * eccentricityEarthOrbit * eccentricityEarthOrbit * Math.sin(2 * geomMeanAnomalySun * RAD)) * DEG;

  // 12. Solar Time Calculation
  // Get time of day in minutes (UTC)
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60000;
  
  // True Solar Time in minutes
  let trueSolarTime = utcMinutes + eqTime + 4 * lon;
  while (trueSolarTime < 0) trueSolarTime += 1440;
  trueSolarTime = trueSolarTime % 1440;

  // Solar Hour Angle (degrees)
  let hourAngle = trueSolarTime / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  // 13. Solar Zenith and Elevation (degrees)
  const decRad = sunDeclination * RAD;
  const haRad = hourAngle * RAD;
  
  let zenith = Math.acos(Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad)) * DEG;
  let elevation = 90 - zenith;

  // Refraction correction (approximate)
  let refractionCorr = 0;
  if (elevation > 85) {
    refractionCorr = 0;
  } else {
    const te = Math.tan(elevation * RAD);
    if (elevation > 5) {
      refractionCorr = 58.1 / te - 0.07 / (te * te * te) + 0.000086 / (te * te * te * te * te);
    } else if (elevation > -0.575) {
      refractionCorr = 1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)));
    } else {
      refractionCorr = -20.772 / te;
    }
    refractionCorr = refractionCorr / 3600;
  }
  elevation = elevation + refractionCorr;

  // 14. Solar Azimuth (degrees clockwise from North)
  let azimuth = 0;
  const zenithRad = zenith * RAD;
  if (zenithRad > 0) {
    let azCos = (Math.sin(decRad) - Math.sin(latRad) * Math.cos(zenithRad)) / (Math.cos(latRad) * Math.sin(zenithRad));
    // Clamp to [-1, 1] to avoid NaN from floating point precision issues
    azCos = Math.max(-1, Math.min(1, azCos));
    
    azimuth = Math.acos(azCos) * DEG;
    if (hourAngle > 0) {
      azimuth = (360 - azimuth) % 360;
    } else {
      azimuth = (180 + azimuth) % 360; // Correct quadrant for morning
    }
  }

  // Double check azimuth correction for NOAA convention
  // NOAA Solar Calculator formula for Azimuth:
  // if (hourAngle > 0) {
  //   azimuth = (360 - ACOSH( (sin(dec) - sin(lat)*cos(zenith)) / (cos(lat)*sin(zenith)) )) % 360
  // } else {
  //   azimuth = (360 + ACOSH( ... )) % 360
  // }
  // Let's implement this cleanly:
  const checkAngleRad = Math.acos(Math.max(-1, Math.min(1, (Math.sin(decRad) - Math.sin(latRad) * Math.cos(zenithRad)) / (Math.cos(latRad) * Math.sin(zenithRad)))));
  let cleanAzimuth = checkAngleRad * DEG;
  if (hourAngle > 0) {
    cleanAzimuth = (360 - cleanAzimuth) % 360;
  } else {
    cleanAzimuth = (360 + cleanAzimuth) % 360;
  }

  // Ensure azimuth is relative to North (NOAA formula already is)
  return {
    azimuth: cleanAzimuth,
    elevation: elevation
  };
}
