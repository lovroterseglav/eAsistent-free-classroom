export interface Period {
  number: number;
  label: string;
  startMinute: number;
  endMinute: number;
}

export interface Classroom {
  id: string;
  name: string;
  url: string;
}

export interface SchoolInspection {
  v: 1;
  school: {
    token: string;
    name: string;
    canonicalUrl: string;
  };
  dates: string[];
  periods: Period[];
  classroomCount: number;
  fetchedAt: string;
}

export interface AvailabilityResult {
  v: 1;
  school: SchoolInspection["school"];
  date: string;
  period: Period;
  rooms: {
    free: Array<Pick<Classroom, "id" | "name">>;
    unknown: Array<Pick<Classroom, "id" | "name">>;
    occupiedCount: number;
    totalCount: number;
  };
  fetchedAt: string;
}

export interface InspectedSchool {
  inspection: SchoolInspection;
  classrooms: Classroom[];
}

export type RoomState = "free" | "occupied" | "unknown";
