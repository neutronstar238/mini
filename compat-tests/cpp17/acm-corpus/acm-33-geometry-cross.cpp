#include <bits/stdc++.h>
using namespace std;
struct P{int x,y;};int c(P a,P b,P d){return (b.x-a.x)*(d.y-a.y)-(b.y-a.y)*(d.x-a.x);}
int main(){cout<<c({0,0},{2,0},{0,3})<<"\n";}
