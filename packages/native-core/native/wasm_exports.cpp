#include "collision_core.h"

using avara::native_core::FindRayDistance;
using avara::native_core::FindSegmentImpact;
using avara::native_core::SegmentImpact;
using avara::native_core::Vec3;

extern "C" {

SegmentImpact avara_find_segment_impact(const double *triangles,
                                        unsigned long triangleCount,
                                        double startX,
                                        double startY,
                                        double startZ,
                                        double endX,
                                        double endY,
                                        double endZ,
                                        double radius) {
    return FindSegmentImpact(
        triangles,
        static_cast<std::size_t>(triangleCount),
        Vec3{startX, startY, startZ},
        Vec3{endX, endY, endZ},
        radius
    );
}

double avara_find_ray_distance(const double *triangles,
                               unsigned long triangleCount,
                               double originX,
                               double originY,
                               double originZ,
                               double targetX,
                               double targetY,
                               double targetZ) {
    double distance = 0.0;
    const bool hit = FindRayDistance(
        triangles,
        static_cast<std::size_t>(triangleCount),
        Vec3{originX, originY, originZ},
        Vec3{targetX, targetY, targetZ},
        &distance
    );

    return hit ? distance : -1.0;
}

}
