#pragma once

#include <cstddef>

namespace avara::native_core {

struct Vec3 {
    double x;
    double y;
    double z;
};

struct SegmentImpact {
    bool hit;
    double t;
    Vec3 point;
};

SegmentImpact FindSegmentImpact(const double *triangles,
                                std::size_t triangleCount,
                                const Vec3 &start,
                                const Vec3 &end,
                                double radius);

bool FindRayDistance(const double *triangles,
                     std::size_t triangleCount,
                     const Vec3 &origin,
                     const Vec3 &target,
                     double *outDistance);

} // namespace avara::native_core
