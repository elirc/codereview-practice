// Package geo computes great-circle distances for services without PostGIS positions.
package geo

import "math"

// EarthRadiusM is the mean Earth radius in metres.
const EarthRadiusM = 6371008.8

// DistanceM returns the haversine distance in metres between two lon/lat points.
func DistanceM(lon1, lat1, lon2, lat2 float64) float64 {
	phi1 := lat1 * math.Pi / 180
	phi2 := lat2 * math.Pi / 180
	dPhi := (lat2 - lat1) * math.Pi / 180
	dLambda := (lon2 - lon1) * math.Pi / 180
	a := math.Sin(dPhi/2)*math.Sin(dPhi/2) + math.Cos(phi1)*math.Cos(phi2)*math.Sin(dLambda/2)*math.Sin(dLambda/2)
	return 2 * EarthRadiusM * math.Asin(math.Min(1, math.Sqrt(a)))
}

// CeilM returns DistanceM rounded up to a whole metre.
func CeilM(lon1, lat1, lon2, lat2 float64) int64 {
	return int64(math.Ceil(DistanceM(lon1, lat1, lon2, lat2)))
}

// ValidLon reports whether lon is a longitude in [-180, 180].
func ValidLon(lon float64) bool {
	return !math.IsNaN(lon) && lon >= -180 && lon <= 180
}

// ValidLat reports whether lat is a latitude in [-90, 90].
func ValidLat(lat float64) bool {
	return !math.IsNaN(lat) && lat >= -90 && lat <= 90
}
