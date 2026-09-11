-- AlterTable
ALTER TABLE "TripItem" ADD COLUMN "typecode" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TripDay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "dayIndex" INTEGER NOT NULL,
    "date" DATETIME NOT NULL,
    "weather" TEXT,
    "summary" TEXT,
    "dayType" TEXT NOT NULL DEFAULT 'normal',
    "intensity" TEXT NOT NULL DEFAULT 'medium',
    CONSTRAINT "TripDay_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TripDay" ("date", "dayIndex", "id", "summary", "tripId", "weather") SELECT "date", "dayIndex", "id", "summary", "tripId", "weather" FROM "TripDay";
DROP TABLE "TripDay";
ALTER TABLE "new_TripDay" RENAME TO "TripDay";
CREATE UNIQUE INDEX "TripDay_tripId_dayIndex_key" ON "TripDay"("tripId", "dayIndex");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
