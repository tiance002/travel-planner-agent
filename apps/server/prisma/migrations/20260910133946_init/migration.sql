-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UserSetting" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL DEFAULT '',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "modelName" TEXT NOT NULL DEFAULT '',
    "apiKeyCipher" BLOB,
    "apiKeyIv" BLOB,
    "apiKeyTag" BLOB,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "cityName" TEXT NOT NULL,
    "cityAdcode" TEXT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "days" INTEGER NOT NULL,
    "travelers" INTEGER NOT NULL,
    "preferences" TEXT NOT NULL DEFAULT '[]',
    "extraNeeds" TEXT NOT NULL DEFAULT '[]',
    "budgetAmount" REAL,
    "budgetScope" TEXT NOT NULL DEFAULT 'per_person',
    "stayResolved" BOOLEAN NOT NULL DEFAULT false,
    "stayPoiId" TEXT,
    "stayName" TEXT,
    "stayLng" REAL,
    "stayLat" REAL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Trip_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TripDay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "dayIndex" INTEGER NOT NULL,
    "date" DATETIME NOT NULL,
    "weather" TEXT,
    "summary" TEXT,
    CONSTRAINT "TripDay_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TripItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripDayId" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "slot" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "poiId" TEXT,
    "name" TEXT NOT NULL,
    "lng" REAL,
    "lat" REAL,
    "address" TEXT,
    "tel" TEXT,
    "rating" TEXT,
    "cost" TEXT,
    "tag" TEXT,
    "openTimeText" TEXT,
    "note" TEXT,
    "checkedAt" DATETIME,
    CONSTRAINT "TripItem_tripDayId_fkey" FOREIGN KEY ("tripDayId") REFERENCES "TripDay" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "Trip_userId_idx" ON "Trip"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TripDay_tripId_dayIndex_key" ON "TripDay"("tripId", "dayIndex");

-- CreateIndex
CREATE INDEX "TripItem_tripDayId_idx" ON "TripItem"("tripDayId");
