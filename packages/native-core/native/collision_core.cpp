#include "collision_core.h"

#include <cmath>
#include <limits>

namespace avara::native_core {

namespace {

Vec3 Subtract(const Vec3 &left, const Vec3 &right) {
    return {left.x - right.x, left.y - right.y, left.z - right.z};
}

Vec3 Cross(const Vec3 &left, const Vec3 &right) {
    return {
        left.y * right.z - left.z * right.y,
        left.z * right.x - left.x * right.z,
        left.x * right.y - left.y * right.x,
    };
}

double Dot(const Vec3 &left, const Vec3 &right) {
    return left.x * right.x + left.y * right.y + left.z * right.z;
}

double Distance(const Vec3 &left, const Vec3 &right) {
    const auto delta = Subtract(left, right);
    return std::sqrt(Dot(delta, delta));
}

bool SegmentTriangleIntersection(const Vec3 &start,
                                 const Vec3 &end,
                                 const Vec3 &a,
                                 const Vec3 &b,
                                 const Vec3 &c,
                                 double *outT) {
    const Vec3 direction = Subtract(end, start);
    const Vec3 edge1 = Subtract(b, a);
    const Vec3 edge2 = Subtract(c, a);
    const Vec3 pvec = Cross(direction, edge2);
    const double determinant = Dot(edge1, pvec);
    if (std::fabs(determinant) < 0.000001) {
        return false;
    }

    const double inverseDeterminant = 1.0 / determinant;
    const Vec3 tvec = Subtract(start, a);
    const double u = Dot(tvec, pvec) * inverseDeterminant;
    if (u < 0.0 || u > 1.0) {
        return false;
    }

    const Vec3 qvec = Cross(tvec, edge1);
    const double v = Dot(direction, qvec) * inverseDeterminant;
    if (v < 0.0 || (u + v) > 1.0) {
        return false;
    }

    const double t = Dot(edge2, qvec) * inverseDeterminant;
    if (t < 0.0 || t > 1.0) {
        return false;
    }

    *outT = t;
    return true;
}

Vec3 Lerp(const Vec3 &start, const Vec3 &end, double t) {
    return {
        start.x + (end.x - start.x) * t,
        start.y + (end.y - start.y) * t,
        start.z + (end.z - start.z) * t,
    };
}

} // namespace

SegmentImpact FindSegmentImpact(const double *triangles,
                                std::size_t triangleCount,
                                const Vec3 &start,
                                const Vec3 &end,
                                double /* radius */) {
    double bestT = std::numeric_limits<double>::infinity();
    bool hit = false;

    for (std::size_t index = 0; index < triangleCount; index += 1) {
        const std::size_t base = index * 9;
        const Vec3 a{triangles[base], triangles[base + 1], triangles[base + 2]};
        const Vec3 b{triangles[base + 3], triangles[base + 4], triangles[base + 5]};
        const Vec3 c{triangles[base + 6], triangles[base + 7], triangles[base + 8]};
        double t = 0.0;
        if (SegmentTriangleIntersection(start, end, a, b, c, &t) && t < bestT) {
            bestT = t;
            hit = true;
        }
    }

    if (!hit) {
        return {false, 0.0, start};
    }

    return {true, bestT, Lerp(start, end, bestT)};
}

bool FindRayDistance(const double *triangles,
                     std::size_t triangleCount,
                     const Vec3 &origin,
                     const Vec3 &target,
                     double *outDistance) {
    const SegmentImpact impact = FindSegmentImpact(triangles, triangleCount, origin, target, 0.0);
    if (!impact.hit) {
        return false;
    }

    *outDistance = Distance(origin, impact.point);
    return true;
}

} // namespace avara::native_core
