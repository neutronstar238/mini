#include <bits/stdc++.h>
using namespace std;
int main(){vector<int>a{4,1,9,2};priority_queue<int,vector<int>,greater<int>>q;for(int x:a){q.push(x);if(q.size()>2)q.pop();}cout<<q.top()<<"\n";}
