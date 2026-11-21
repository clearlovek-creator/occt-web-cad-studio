#pragma once
#include <string>
namespace occweb {
// Opens an independent XBF document, reads metadata only, never restores a live
// CadDocument, rebuilds names, recomputes features or writes a snapshot.
std::string InspectSnapshotSources(const std::string& file);
}
